import os
import secrets
import sys


def _attach_stdio():
    """Give print() somewhere to go when there is no console.

    Under pythonw.exe (GUI subsystem) the process gets no console, so
    sys.stdout and sys.stderr are None and every print() raises
    AttributeError. All of the prints in this file sit inside `except` blocks,
    so without this a handled, survivable error would crash the widget
    instead. Log to a file rather than os.devnull: these lines are the only
    record of what went wrong in a window with nowhere to show it.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    stream = None
    try:
        path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "database", "widget.log"
        )
        os.makedirs(os.path.dirname(path), exist_ok=True)
        stream = open(path, "a", encoding="utf-8", errors="replace", buffering=1)
    except Exception:
        try:
            stream = open(os.devnull, "w", encoding="utf-8")
        except Exception:
            return
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


_attach_stdio()

# Must be set before webview (and therefore WebView2) starts. WebView2 is Chromium
# and throttles timers in a window it thinks nobody is looking at, down to about
# once a minute -- which stops the widget's clock and stalls the desk controller
# whenever the widget is covered by something else. The same flags are passed to
# the main window in planner-launcher.pyw.
os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = " ".join([
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion",
    # Any UI Automation client on the PC (Windows tools, window managers) turns
    # on Chromium's accessibility tree, and its pending updates were measured
    # piling up in the widget's memory without end. Nothing here needs it.
    "--disable-renderer-accessibility",
] + (
    # Opt-in DevTools port for measuring memory in the real windows (heap
    # snapshots over CDP). Off unless the variable is set; loopback only.
    ["--remote-debugging-port=" + os.environ["PLANNER_WEBVIEW_DEBUG_PORT"]]
    if os.environ.get("PLANNER_WEBVIEW_DEBUG_PORT", "").isdigit() else []
))

import webview
import ctypes
import ctypes.wintypes
import threading
import time

_resizing = False
_old_wndproc = None
_new_wndproc = None
_always_on_top_enabled = True

# A random pairing capability for the widget *window*, not an authentication
# token: the local server only attaches it to an account after the signed-in
# main app explicitly approves it. It predates the main window moving into
# WebView2 (the two used to have separate cookie stores) and is kept because
# the pairing flow still keys on it.
WIDGET_PAIRING_ID = secrets.token_hex(32)

# Both windows. Module-level because the Win32 helpers above and below reach
# the widget through `window`; run_windows() assigns them.
window = None
main_window = None


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ('cbSize', ctypes.wintypes.DWORD),
        ('rcMonitor', ctypes.wintypes.RECT),
        ('rcWork', ctypes.wintypes.RECT),
        ('dwFlags', ctypes.wintypes.DWORD),
    ]


MONITOR_DEFAULTTONULL = 0
MONITOR_DEFAULTTONEAREST = 2


def rescue_hwnd(hwnd):
    """Pull one window back onto a real monitor. Returns the new (x, y, w, h), or
    None when the window was already fine (or could not be moved).

    Unplugging the second screen does NOT reliably move a top-most, caption-less
    window with it: Windows leaves it sitting at coordinates that no longer
    belong to any display, so it is running and reachable only from the taskbar
    while being invisible on every remaining screen.

    "Off-screen" is judged by the window's CENTRE, not by any overlap — a window
    hanging a few pixels into the primary display is just as unusable as one
    parked entirely outside it.
    """
    try:
        if not hwnd:
            return None
        # A minimized window reports a placeholder rect (-32000, -32000); moving
        # it would corrupt the position it restores to.
        if user32.IsIconic(hwnd):
            return None

        rect = ctypes.wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None
        w = rect.right - rect.left
        h = rect.bottom - rect.top
        if w <= 0 or h <= 0:
            return None

        centre = ctypes.wintypes.POINT(rect.left + w // 2, rect.top + h // 2)
        if user32.MonitorFromPoint(centre, MONITOR_DEFAULTTONULL):
            return None  # its middle is on a live display — nothing to do

        monitor = user32.MonitorFromRect(ctypes.byref(rect), MONITOR_DEFAULTTONEAREST)
        if not monitor:
            return None
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            return None

        work = info.rcWork
        # Shrink before clamping: a widget sized for a big second screen may not
        # fit the laptop panel, and a too-tall window can't be clamped into view.
        new_w = min(w, work.right - work.left)
        new_h = min(h, work.bottom - work.top)
        new_x = min(max(rect.left, work.left), work.right - new_w)
        new_y = min(max(rect.top, work.top), work.bottom - new_h)

        SWP_NOZORDER = 0x0004
        SWP_NOACTIVATE = 0x0010
        SWP_SHOWWINDOW = 0x0040
        user32.SetWindowPos(hwnd, 0, new_x, new_y, new_w, new_h,
                            SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)
        return (new_x, new_y, new_w, new_h)
    except Exception as e:
        print("Failed to rescue off-screen widget:", e)
        return None


def rescue_offscreen_window():
    """Rescue the widget window itself, if it is up."""
    try:
        if 'window' not in globals() or not window or not getattr(window, 'native', None):
            return
        rescue_hwnd(int(window.native.Handle.ToInt64()))
    except Exception as e:
        print("Failed to rescue off-screen widget:", e)


def schedule_rescue():
    """Re-check a few times after a display change.

    Windows re-arranges monitors over several hundred milliseconds and moves some
    windows itself, so one immediate check can either run too early (the old
    layout is still reported) or undo what Windows was about to do anyway.
    """
    for delay in (0.4, 1.5, 3.5):
        threading.Timer(delay, rescue_offscreen_window).start()


def force_topmost_loop():
    """Background daemon thread that forcefully re-elevates the widget window to top-most Z-order

    without stealing keyboard/input focus, ensuring it stays on top of demanding apps.
    """
    HWND_TOPMOST = -1
    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SWP_NOACTIVATE = 0x0010
    SWP_SHOWWINDOW = 0x0040
    GWL_EXSTYLE = -20
    WS_EX_TOPMOST = 0x00000008

    ticks = 0
    while True:
        time.sleep(0.5)
        # Safety net for the off-screen case: WM_DISPLAYCHANGE is the fast path,
        # but it isn't delivered for every way a display can vanish (docking,
        # RDP, waking with the second screen already gone), so re-check
        # periodically. It costs two Win32 calls when nothing is wrong.
        ticks += 1
        if ticks % 8 == 0:
            rescue_offscreen_window()

        if _always_on_top_enabled and 'window' in globals() and window and hasattr(window, 'native') and window.native:
            try:
                hwnd = int(window.native.Handle.ToInt64())
                if hwnd:
                    ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                    if not (ex & WS_EX_TOPMOST):
                        user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOPMOST)
                    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
            except Exception:
                pass

# Declare ctypes function signatures to prevent memory Access Violations
user32 = ctypes.WinDLL('user32')

# GetWindowRect signature
user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.wintypes.RECT)]
user32.GetWindowRect.restype = ctypes.wintypes.BOOL

# CallWindowProcW signature
user32.CallWindowProcW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint64, ctypes.c_int64]
user32.CallWindowProcW.restype = ctypes.c_int64

# SetWindowPos signature
user32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
user32.SetWindowPos.restype = ctypes.wintypes.BOOL

# ReleaseCapture & PostMessageW signatures for programmatic dragging
user32.ReleaseCapture.argtypes = []
user32.ReleaseCapture.restype = ctypes.wintypes.BOOL

user32.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint64, ctypes.c_int64]
user32.PostMessageW.restype = ctypes.wintypes.BOOL

# Cursor + key state — used by the manual drag loop.
user32.GetCursorPos.argtypes = [ctypes.POINTER(ctypes.wintypes.POINT)]
user32.GetCursorPos.restype = ctypes.wintypes.BOOL

user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.c_short

# ShowWindow / LoadImageW / SendMessageW — used to force a taskbar button and icon
user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.ShowWindow.restype = ctypes.wintypes.BOOL

user32.LoadImageW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
user32.LoadImageW.restype = ctypes.c_void_p

user32.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint64, ctypes.c_void_p]
user32.SendMessageW.restype = ctypes.c_int64

# Monitor queries — used to rescue the widget when a screen is unplugged.
user32.MonitorFromPoint.argtypes = [ctypes.wintypes.POINT, ctypes.wintypes.DWORD]
user32.MonitorFromPoint.restype = ctypes.c_void_p

user32.MonitorFromRect.argtypes = [ctypes.POINTER(ctypes.wintypes.RECT), ctypes.wintypes.DWORD]
user32.MonitorFromRect.restype = ctypes.c_void_p

user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(MONITORINFO)]
user32.GetMonitorInfoW.restype = ctypes.wintypes.BOOL

user32.IsIconic.argtypes = [ctypes.c_void_p]
user32.IsIconic.restype = ctypes.wintypes.BOOL

# Give the widget its own taskbar identity instead of inheriting pythonw.exe's,
# which is what makes Windows show our icon rather than a generic Python one.
try:
    ctypes.WinDLL('shell32').SetCurrentProcessExplicitAppUserModelID('Planner.TodaySchedule.Widget')
except Exception as _e:
    pass

# Window Long functions depending on pointer size (64-bit / 32-bit)
IS_64BIT = ctypes.sizeof(ctypes.c_void_p) == 8

if IS_64BIT:
    user32.GetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int]
    user32.GetWindowLongPtrW.restype = ctypes.c_void_p
    user32.SetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    user32.SetWindowLongPtrW.restype = ctypes.c_void_p
    GWL_WNDPROC = -4
else:
    user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.SetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_long]
    user32.SetWindowLongW.restype = ctypes.c_long
    GWL_WNDPROC = -4

# Standard Style Accessors
user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.GetWindowLongW.restype = ctypes.c_long
user32.SetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_long]
user32.SetWindowLongW.restype = ctypes.c_long

user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
user32.GetWindowTextLengthW.restype = ctypes.c_int

user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int

user32.IsWindow.argtypes = [ctypes.c_void_p]
user32.IsWindow.restype = ctypes.wintypes.BOOL

user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
user32.IsWindowVisible.restype = ctypes.wintypes.BOOL

user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
user32.SetForegroundWindow.restype = ctypes.wintypes.BOOL

user32.BringWindowToTop.argtypes = [ctypes.c_void_p]
user32.BringWindowToTop.restype = ctypes.wintypes.BOOL

user32.IsZoomed.argtypes = [ctypes.c_void_p]
user32.IsZoomed.restype = ctypes.wintypes.BOOL



VK_LBUTTON = 0x01
_drag_thread = None


def _drag_loop(hwnd):
    """Move `hwnd` with the cursor until the left mouse button is released."""
    SWP_NOSIZE = 0x0001
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    try:
        pt = ctypes.wintypes.POINT()
        if not user32.GetCursorPos(ctypes.byref(pt)):
            return
        rect = ctypes.wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return
        off_x = rect.left - pt.x
        off_y = rect.top - pt.y

        last = None
        while user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000:
            if not user32.GetCursorPos(ctypes.byref(pt)):
                break
            pos = (pt.x + off_x, pt.y + off_y)
            if pos != last:
                last = pos
                user32.SetWindowPos(hwnd, 0, pos[0], pos[1], 0, 0,
                                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
            time.sleep(0.008)
    except Exception as e:
        print("Drag loop failed:", e)


class Api:
    def minimize(self):
        window.minimize()
    def close(self):
        window.destroy()
    
    def start_drag(self):
        """Drag the window ourselves, following the physical cursor.

        The old approach posted WM_SYSCOMMAND/SC_MOVE after ReleaseCapture(),
        which is the standard trick for a frameless window -- but it only works
        when the capturing control lives in this process. WebView2 renders in a
        separate process (msedgewebview2.exe), so our ReleaseCapture() frees
        nothing, the OS move loop starts with no mouse input reaching it, and the
        window simply never follows the cursor. Polling the cursor and moving the
        window directly sidesteps process boundaries entirely.
        """
        global _drag_thread
        try:
            if _drag_thread and _drag_thread.is_alive():
                return
            hwnd = int(window.native.Handle.ToInt64())
            _drag_thread = threading.Thread(target=_drag_loop, args=(hwnd,), daemon=True)
            _drag_thread.start()
        except Exception as e:
            print("Failed to start native drag:", e)
    def move_window_relative(self, dx, dy):
        try:
            hwnd = int(window.native.Handle.ToInt64())
            rect = ctypes.wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            
            SWP_NOSIZE = 0x0001
            SWP_NOZORDER = 0x0004
            SWP_SHOWWINDOW = 0x0040
            
            new_x = rect.left + int(dx)
            new_y = rect.top + int(dy)
            
            user32.SetWindowPos(hwnd, 0, new_x, new_y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW)
        except Exception as e:
            print("Failed to move window relatively:", e)
    def open_browser(self):
        """Show the main planner window. It lives in this same process (see
        run_windows), so there is nothing to launch: closing it only hid it."""
        show_main_window()

    def set_always_on_top(self, on_top):
        global _always_on_top_enabled
        _always_on_top_enabled = bool(on_top)
        HWND_TOPMOST = -1
        HWND_NOTOPMOST = -2
        SWP_NOMOVE = 0x0002
        SWP_NOSIZE = 0x0001
        SWP_NOACTIVATE = 0x0010
        SWP_SHOWWINDOW = 0x0040
        GWL_EXSTYLE = -20
        WS_EX_TOPMOST = 0x00000008
        try:
            hwnd = int(window.native.Handle.ToInt64())
            ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            if _always_on_top_enabled:
                user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOPMOST)
                target = HWND_TOPMOST
            else:
                user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex & ~WS_EX_TOPMOST)
                target = HWND_NOTOPMOST
            user32.SetWindowPos(hwnd, target, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
        except Exception as e:
            print("Failed to toggle top-most:", e)


# Win32 Constants
WM_NCHITTEST = 0x0084
WM_DISPLAYCHANGE = 0x007E
HTCLIENT = 1
HTLEFT = 10
HTRIGHT = 11
HTTOP = 12
HTTOPLEFT = 13
HTTOPRIGHT = 14
HTBOTTOM = 15
HTBOTTOMLEFT = 16
HTBOTTOMRIGHT = 17

def wndproc(hwnd, msg, wparam, lparam):
    if msg == WM_DISPLAYCHANGE:
        # A screen was plugged in, unplugged or re-arranged. Check off the message
        # loop (via timers) so the window procedure returns immediately.
        schedule_rescue()

    if msg == WM_NCHITTEST:
        # Decode signed 16-bit coordinates from lparam
        x_raw = lparam & 0xFFFF
        y_raw = (lparam >> 16) & 0xFFFF
        x = x_raw - 65536 if x_raw >= 32768 else x_raw
        y = y_raw - 65536 if y_raw >= 32768 else y_raw

        # Get window position rect
        rect = ctypes.wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))

        border = 8  # grab boundary width in pixels

        is_left = x < rect.left + border
        is_right = x >= rect.right - border
        is_top = y < rect.top + border
        is_bottom = y >= rect.bottom - border

        # Corner hit testing
        if is_left and is_top: return HTTOPLEFT
        if is_right and is_top: return HTTOPRIGHT
        if is_left and is_bottom: return HTBOTTOMLEFT
        if is_right and is_bottom: return HTBOTTOMRIGHT

        # Side hit testing
        if is_left: return HTLEFT
        if is_right: return HTRIGHT
        if is_top: return HTTOP
        if is_bottom: return HTBOTTOM

    # Call the original window procedure
    return user32.CallWindowProcW(_old_wndproc, hwnd, msg, wparam, lparam)

# Create the WNDPROC type callback definition
WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_int64, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint64, ctypes.c_int64)

ICON_PATH = r"D:\My Projects\weekly-planner\app-icon.ico"


def apply_taskbar_presence(hwnd):
    """Force the widget onto the taskbar with its own icon.

    Stripping WS_CAPTION below leaves a window Windows no longer considers a
    taskbar candidate, so the button disappeared entirely. WS_EX_APPWINDOW says
    "show me regardless"; the ex-style only takes effect across a hide/show, and
    the icon has to be set explicitly via WM_SETICON or the button comes up blank.
    """
    GWL_EXSTYLE = -20
    WS_EX_APPWINDOW = 0x00040000
    WS_EX_TOOLWINDOW = 0x00000080
    SW_HIDE = 0
    SW_SHOW = 5
    WM_SETICON = 0x0080
    ICON_SMALL, ICON_BIG = 0, 1
    IMAGE_ICON = 1
    LR_LOADFROMFILE = 0x0010

    SWP_NOMOVE = 0x0002
    SWP_NOZORDER = 0x0004

    try:
        ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        user32.SetWindowLongW(hwnd, GWL_EXSTYLE, (ex | WS_EX_APPWINDOW) & ~WS_EX_TOOLWINDOW)
        user32.ShowWindow(hwnd, SW_HIDE)
        user32.ShowWindow(hwnd, SW_SHOW)

        # WebView2 does not reliably repaint after its host window is hidden and
        # shown again — the window comes back blank white. Nudging the size by a
        # pixel and back forces the browser view to relayout and draw.
        rect = ctypes.wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        w, h = rect.right - rect.left, rect.bottom - rect.top
        flags = SWP_NOMOVE | SWP_NOZORDER
        user32.SetWindowPos(hwnd, 0, 0, 0, w, h + 1, flags)
        user32.SetWindowPos(hwnd, 0, 0, 0, w, h, flags)
    except Exception as e:
        print("Failed to force taskbar presence:", e)

    refresh_webview_visibility()


def refresh_webview_visibility():
    """Tell WebView2 the widget is on screen again after the hide/show above.

    THE LEAK THIS FIXES: the Win32 SW_HIDE left WebView2 believing the page was
    hidden for good (document.visibilityState 'hidden'), and the SW_SHOW never
    told it otherwise. A hidden page gets no animation frames, so every
    requestAnimationFrame the widget asked for (about one a second) was queued
    and never run, each holding its closures. That grew by roughly 1 GB a day
    until the process was killed. Toggling the control's own Visible property
    re-syncs the controller, and has to happen on the WinForms GUI thread.
    """
    try:
        from System import Action
        form = window.native

        def toggle():
            control = form.browser.webview
            control.Visible = False
            control.Visible = True

        form.Invoke(Action(toggle))
    except Exception as e:
        print("Failed to refresh WebView2 visibility:", e)

    try:
        for size, which in ((16, ICON_SMALL), (32, ICON_BIG)):
            hicon = user32.LoadImageW(None, ICON_PATH, IMAGE_ICON, size, size, LR_LOADFROMFILE)
            if hicon:
                user32.SendMessageW(hwnd, WM_SETICON, which, hicon)
    except Exception as e:
        print("Failed to set window icon:", e)


def on_shown():
    global _old_wndproc, _new_wndproc
    GWL_STYLE = -16
    WS_CAPTION = 0x00C00000
    WS_THICKFRAME = 0x00040000
    WS_MINIMIZEBOX = 0x00020000
    WS_SYSMENU = 0x00080000
    SWP_FRAMECHANGED = 0x0020
    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SWP_NOZORDER = 0x0004
    
    try:
        hwnd = int(window.native.Handle.ToInt64())
        
        # Get styles, remove title bar and force frame borders update
        style = user32.GetWindowLongW(hwnd, GWL_STYLE)
        new_style = (style & ~WS_CAPTION) | WS_MINIMIZEBOX | WS_SYSMENU | WS_THICKFRAME
        user32.SetWindowLongW(hwnd, GWL_STYLE, new_style)
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED)

        apply_taskbar_presence(hwnd)

        # Set up window procedure subclassing
        _new_wndproc = WNDPROC(wndproc)
        if IS_64BIT:
            _old_wndproc = user32.GetWindowLongPtrW(hwnd, GWL_WNDPROC)
            user32.SetWindowLongPtrW(hwnd, GWL_WNDPROC, _new_wndproc)
        else:
            _old_wndproc = user32.GetWindowLongW(hwnd, GWL_WNDPROC)
            user32.SetWindowLongW(hwnd, GWL_WNDPROC, _new_wndproc)

        # Start daemon thread to continuously enforce top-most Z-order without stealing focus
        t = threading.Thread(target=force_topmost_loop, daemon=True)
        t.start()

    except Exception as e:
        print("Failed to apply native Win32 style:", e)

# ── Main window: custom title bar ─────────────────────────────────────────────
# The main window keeps its full native frame (WS_CAPTION + WS_THICKFRAME), so
# Snap, Aero Shake, the maximize animation, the drop shadow and the side and
# bottom resize edges all stay Windows' own. Only the caption strip is removed,
# by claiming it as client area in WM_NCCALCSIZE. The page then draws its own
# min/max/close buttons, and marks its toolbar `app-region: drag`, which
# WebView2 turns into a real caption (drag, double-click to maximize, Win+Arrow).
#
# It only switches on after the page says it has drawn its controls
# (MainApi.enable_custom_frame), so an error page or a page that failed to load
# never leaves a window with no way to move or close it.

class NCCALCSIZE_PARAMS(ctypes.Structure):
    _fields_ = [
        ('rgrc', ctypes.wintypes.RECT * 3),
        ('lppos', ctypes.c_void_p),
    ]


WM_NCCALCSIZE = 0x0083
WM_CLOSE = 0x0010
SW_MINIMIZE = 6
SW_MAXIMIZE = 3
SW_RESTORE = 9

_main_custom_frame = False
_main_old_wndproc = None
_main_new_wndproc = None


def _main_hwnd():
    try:
        return int(main_window.native.Handle.ToInt64())
    except Exception:
        return 0


def main_wndproc(hwnd, msg, wparam, lparam):
    if msg == WM_NCCALCSIZE and wparam and _main_custom_frame:
        params = ctypes.cast(lparam, ctypes.POINTER(NCCALCSIZE_PARAMS)).contents
        top_before = params.rgrc[0].top
        left_before = params.rgrc[0].left
        user32.CallWindowProcW(_main_old_wndproc, hwnd, msg, wparam, lparam)
        # Undo only the top inset (caption + top border). A maximized window
        # hangs its frame off the screen edges, so there the top has to keep the
        # same inset as the sides or the toolbar would start above the monitor.
        if user32.IsZoomed(hwnd):
            params.rgrc[0].top = top_before + (params.rgrc[0].left - left_before)
        else:
            params.rgrc[0].top = top_before
        return 0
    return user32.CallWindowProcW(_main_old_wndproc, hwnd, msg, wparam, lparam)


def _refresh_main_frame(hwnd):
    SWP_FRAMECHANGED = 0x0020
    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)


def set_main_custom_frame(on):
    global _main_custom_frame, _main_old_wndproc, _main_new_wndproc
    try:
        hwnd = _main_hwnd()
        if not hwnd or bool(on) == _main_custom_frame:
            return
        if _main_new_wndproc is None:
            _main_new_wndproc = WNDPROC(main_wndproc)
            if IS_64BIT:
                _main_old_wndproc = user32.GetWindowLongPtrW(hwnd, GWL_WNDPROC)
                user32.SetWindowLongPtrW(hwnd, GWL_WNDPROC, _main_new_wndproc)
            else:
                _main_old_wndproc = user32.GetWindowLongW(hwnd, GWL_WNDPROC)
                user32.SetWindowLongW(hwnd, GWL_WNDPROC, _main_new_wndproc)
        _main_custom_frame = bool(on)
        _refresh_main_frame(hwnd)
    except Exception as e:
        print("Failed to switch the main window frame:", e)


class MainApi:
    """Window controls for the main window's own title bar (window.pywebview.api)."""

    def enable_custom_frame(self):
        set_main_custom_frame(True)
        return self.window_state()

    def window_state(self):
        hwnd = _main_hwnd()
        return {'custom': _main_custom_frame, 'maximized': bool(hwnd and user32.IsZoomed(hwnd))}

    def minimize(self):
        hwnd = _main_hwnd()
        if hwnd:
            user32.ShowWindow(hwnd, SW_MINIMIZE)

    def toggle_maximize(self):
        hwnd = _main_hwnd()
        if hwnd:
            user32.ShowWindow(hwnd, SW_RESTORE if user32.IsZoomed(hwnd) else SW_MAXIMIZE)
        return self.window_state()

    def close(self):
        # Exactly what the old X button did: WM_CLOSE, which on_main_closing
        # turns into a hide while the widget is up.
        hwnd = _main_hwnd()
        if hwnd:
            user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)


def _check_main_frame_after_load():
    """Put the native title bar back if the loaded page has no controls of its
    own (the WebView2 error page while the server is down, for one)."""
    if not _main_custom_frame:
        return
    try:
        has_controls = main_window.evaluate_js(
            "!!document.querySelector('[data-window-controls]')")
    except Exception:
        has_controls = False
    if not has_controls:
        set_main_custom_frame(False)


def on_main_loaded():
    detach_network_hooks(main_window)
    # Give the page time to mount (and to call enable_custom_frame itself).
    threading.Timer(4.0, _check_main_frame_after_load).start()


def enable_webview_app_region():
    """Let the main window's page use `app-region: drag` (WebView2 1.0.2420+).

    The setting has to be on before the first navigation, and pywebview gives
    no hook there, so wrap its ready handler: turn it on, then let pywebview
    carry on and navigate as usual. Only the main window gets it; the widget
    drags itself (see Api.start_drag)."""
    try:
        from webview.platforms.edgechromium import EdgeChrome
    except Exception as e:
        print("Could not load pywebview's WebView2 backend:", e)
        return
    original = EdgeChrome.on_webview_ready

    def on_webview_ready(self, sender, args):
        try:
            if args.IsSuccess and self.pywebview_window is main_window:
                sender.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = True
        except Exception as e:
            print("Failed to enable app-region support:", e)
        return original(self, sender, args)

    EdgeChrome.on_webview_ready = on_webview_ready


def already_running():
    """True if a widget window is already open — launching the app twice used to
    stack up duplicate widgets, each syncing and sounding independently."""
    ERROR_ALREADY_EXISTS = 183
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateMutexW(None, False, 'Global\\PlannerWidgetWindow')
    return ctypes.get_last_error() == ERROR_ALREADY_EXISTS


def detach_network_hooks(win):
    """Stop pywebview from watching every request and response.

    THE OTHER LEAK. pywebview always subscribes to WebView2's
    WebResourceResponseReceived and WebResourceRequested (for its optional
    request_sent / response_received events, which this app never uses).
    Subscribing makes WebView2 turn on its DevTools network tracking, which keeps
    a record of every response for as long as the page lives. The planner polls
    the server several times a second, so that alone grew each window by about
    2 MB every few minutes, forever. It also marshalled every request through
    .NET into Python for nothing.

    Runs on the WinForms GUI thread once the page has loaded (CoreWebView2
    exists by then). Removing a handler pythonnet does not find is harmless.
    """
    try:
        from System import Action
        form = win.native
        browser = form.browser

        def detach():
            core = browser.webview.CoreWebView2
            if core is None:
                return
            try:
                core.WebResourceResponseReceived -= browser.on_web_resource_response
            except Exception as e:
                print("Failed to detach response hook:", e)
            try:
                core.WebResourceRequested -= browser.on_web_resource_request
            except Exception as e:
                print("Failed to detach request hook:", e)
            try:
                from Microsoft.Web.WebView2.Core import CoreWebView2WebResourceContext
                core.RemoveWebResourceRequestedFilter('*', CoreWebView2WebResourceContext.All)
            except Exception as e:
                print("Failed to remove request filter:", e)

        form.Invoke(Action(detach))
    except Exception as e:
        print("Failed to detach WebView2 network hooks:", e)


def show_main_window():
    """Bring the main planner window back, from hidden or minimized."""
    if main_window is None:
        return
    try:
        main_window.show()
        main_window.restore()
        hwnd = int(main_window.native.Handle.ToInt64())
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    except Exception as e:
        print("Failed to show main window:", e)


def _main_is_hidden():
    try:
        hwnd = int(main_window.native.Handle.ToInt64())
        return not user32.IsWindowVisible(hwnd)
    except Exception:
        return True


def on_main_closing():
    """Closing the main window HIDES it while the widget is still up.

    Both windows live in one process, which holds the launcher mutex for as long
    as it runs. A destroyed main window could then never come back: a toast
    click starts a second launcher, which sees the mutex and can only focus an
    EXISTING window. Hidden, the window is still there to be shown again (by the
    widget's open button, a toast, or the Daily Planner shortcut). The closing
    event runs on the GUI thread and waits for this handler, so the hide itself
    has to happen off it.
    """
    if window is not None and window in webview.windows:
        threading.Thread(target=main_window.hide, daemon=True).start()
        return False
    return True


def on_widget_closing():
    """Closing the widget while the main window is hidden quits the app.

    Otherwise an invisible main window would keep the process (and its memory,
    and the launcher mutex) alive with nothing on screen to close. This is also
    what lets a restart finish: it posts WM_CLOSE to both windows, the main one
    hides, and this then takes everything down so the relaunch is not blocked.
    """
    if main_window is not None and main_window in webview.windows and _main_is_hidden():
        threading.Thread(target=main_window.destroy, daemon=True).start()
    return True


def run_windows(show_main=True):
    """Open the main planner window and the widget in THIS process, both on one
    WebView2 environment. `show_main=False` (the widget launched on its own by
    the server) still creates the main window, hidden, so the widget's open
    button has something to show."""
    global window, main_window
    if already_running():
        import sys as _sys
        _sys.exit(0)
    api = Api()
    enable_webview_app_region()

    main_window = webview.create_window(
        title="Daily Planner",
        url='http://127.0.0.1:5173',
        width=1280,
        height=800,
        frameless=False,
        resizable=True,
        hidden=not show_main,
        js_api=MainApi(),
    )
    main_window.events.closing += on_main_closing
    main_window.events.loaded += on_main_loaded

    # Create the widget window (not frameless), which we then border-strip in on_shown
    window = webview.create_window(
        title="Today's Schedule",
        url=f'http://127.0.0.1:5173/widget?widgetSession={WIDGET_PAIRING_ID}',
        width=340,
        height=720,
        frameless=False,  # Set to False so OS creates standard window and enables resize borders
        on_top=True,      # Start as always-on-top
        resizable=True,
        js_api=api
    )
    # Bind events
    window.events.shown += on_shown
    window.events.closing += on_widget_closing
    window.events.loaded += lambda: detach_network_hooks(window)

    # Start the webview window loop with custom application icon. A persistent
    # profile (not private mode) keeps the login cookie across restarts.
    base_dir = os.path.dirname(os.path.abspath(__file__))
    webview.start(
        icon=os.path.join(base_dir, 'app-icon.ico'),
        private_mode=False,
        storage_path=os.path.join(base_dir, '.webview-profile')
    )

if __name__ == '__main__':
    # Run directly (the server's "open widget" route): the widget is what was
    # asked for, so the main window starts hidden.
    run_windows(show_main=False)
