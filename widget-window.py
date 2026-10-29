import json
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

user32.ShowWindowAsync.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.ShowWindowAsync.restype = ctypes.wintypes.BOOL



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

    # ── The floating orb (see the "Floating orb" section below) ──

    def orb_info(self):
        return {"enabled": _orb_enabled, "mode": _orb_mode}

    def orb_set_enabled(self, on):
        set_orb_enabled(bool(on))
        return self.orb_info()

    def orb_tuck(self):
        """The widget asked to go back into the orb (its close/minimize/Esc)."""
        if _orb_enabled:
            hide_widget()

    def orb_state(self, frac, running, alert):
        if _orb is not None:
            _orb.set_state(frac, running, alert)

    def voice_orb(self, on, phase, mic, out, muted):
        """Voice mode started from the orb: the page's live state, ~30x a second."""
        if _orb is not None:
            _orb.set_voice(bool(on), phase, mic, out, muted)

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
        if _orb_enabled:
            # In orb mode the orb IS the widget's button: no taskbar entry.
            ex = (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW
        else:
            ex = (ex | WS_EX_APPWINDOW) & ~WS_EX_TOOLWINDOW
        user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
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

    # The hide/show above can leave the button on the generic icon; put the
    # widget's own back.
    set_form_icon(window, WIDGET_ICON_PATH)


# Each window has its own taskbar icon, so the two buttons can be told apart:
# a wide window for the planner, a tall one for the widget (drawn by
# tools/make-window-icons.py).
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MAIN_ICON_PATH = os.path.join(_BASE_DIR, "icon-main.ico")
WIDGET_ICON_PATH = os.path.join(_BASE_DIR, "icon-widget.ico")


def set_form_icon(win, path):
    """Set a window's own icon (title bar, Alt+Tab and its taskbar button).

    Through the WinForms property rather than WM_SETICON: WinForms re-sends
    its Icon whenever it recreates the handle, which would quietly undo a
    message sent from outside."""
    if not win or not os.path.exists(path):
        return
    try:
        from System import Action
        from System.Drawing import Icon
        form = win.native

        def apply():
            form.Icon = Icon(path)

        form.Invoke(Action(apply))
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
        # In orb mode the widget starts tucked away: cloak it before anything
        # below shows it again.
        if _orb_enabled:
            set_cloak(hwnd, True)

        # Get styles, remove title bar and force frame borders update
        style = user32.GetWindowLongW(hwnd, GWL_STYLE)
        new_style = (style & ~WS_CAPTION) | WS_MINIMIZEBOX | WS_SYSMENU | WS_THICKFRAME
        user32.SetWindowLongW(hwnd, GWL_STYLE, new_style)
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED)

        apply_taskbar_presence(hwnd)
        # Belt and braces: the hide/show above must never leave a tucked-away
        # widget sitting on screen at startup.
        if _orb_enabled and _orb_mode is None:
            set_cloak(hwnd, True)

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


def allow_planner_microphone(core):
    """Voice mode needs the microphone. WebView2 would ask with a permission
    prompt every session (and in the cloaked widget nobody would ever see it),
    so the planner's own pages get it straight away. Only the microphone, and
    only for the local planner; anything else keeps WebView2's default."""
    from Microsoft.Web.WebView2.Core import CoreWebView2PermissionKind, CoreWebView2PermissionState

    def on_permission(sender, a):
        try:
            uri = str(a.Uri or "")
            local = uri.startswith("http://127.0.0.1:") or uri.startswith("http://localhost:")
            if local and a.PermissionKind == CoreWebView2PermissionKind.Microphone:
                a.State = CoreWebView2PermissionState.Allow
        except Exception as e:
            print("Microphone permission handler failed:", e)

    core.PermissionRequested += on_permission


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
        try:
            if args.IsSuccess:
                allow_planner_microphone(sender.CoreWebView2)
        except Exception as e:
            print("Failed to set up microphone access:", e)
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
        hwnd = int(main_window.native.Handle.ToInt64())
        # Win32 restore, not pywebview's restore(): that forces the Normal
        # state and would shrink a maximized planner to a small window.
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE: back to maximized if it was
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
    """Closing the main window QUITS the app: main, widget and orb all go and
    the process exits (the user's choice: X means stop). The taskbar icon or a
    toast then starts it again through the launcher. The dev server is a
    separate process and keeps running, so phone sync and reminders do not
    stop. The closing event runs on the GUI thread and waits for this handler,
    so the widget is destroyed off it."""
    global _quit_everything
    _quit_everything = True
    host_log("main window closing: app quits")
    if _orb is not None:
        try:
            _orb.close()
        except Exception:
            pass
    if window is not None and window in webview.windows and not _widget_closed:
        threading.Thread(target=window.destroy, daemon=True).start()
    return True


_widget_closed = False  # once the widget is gone, closing main really quits
_quit_everything = False  # main was closed: the server and hotkey stop too

APP_CLOSED_MARKER = os.path.join(_BASE_DIR, "database", "app-closed")


def stop_background():
    """Closing the planner stops ALL of it (the user's choice): the dev server
    and the focus hotkey as well as the windows.

    database/app-closed tells the link watchdog the server is down on purpose,
    so it does not start the planner again; the launcher deletes it on the next
    start. The server is killed by pid WITHOUT /T: a restart script running
    right now is the server's child and must survive."""
    import subprocess
    no_window = 0x08000000
    try:
        with open(APP_CLOSED_MARKER, "w", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S"))
    except Exception as e:
        host_log("could not write the app-closed marker: %s" % e)

    def run(args):
        try:
            return subprocess.run(args, creationflags=no_window, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  timeout=20).stdout.decode("utf-8", "ignore")
        except Exception as e:
            host_log("%s failed: %s" % (args[0], e))
            return ""

    pids = set()
    for line in run(["netstat", "-ano", "-p", "TCP"]).splitlines():
        parts = line.split()
        if len(parts) >= 5 and "LISTENING" in line and parts[1].endswith(":5173"):
            if parts[-1].isdigit() and parts[-1] != "0":
                pids.add(parts[-1])
    for line in run([
        "powershell", "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' or Name='python.exe'\" "
        "| Where-Object { $_.CommandLine -like '*focus-hotkey.py*' } "
        "| ForEach-Object { $_.ProcessId }",
    ]).splitlines():
        if line.strip().isdigit():
            pids.add(line.strip())
    pids.discard(str(os.getpid()))
    for pid in sorted(pids):
        run(["taskkill", "/PID", pid, "/F"])
    host_log("stopped the server and hotkey (pids %s)" % ", ".join(sorted(pids)))


HOST_LOG = os.path.join(_BASE_DIR, "database", "window-host.log")


def host_log(message):
    """A line in database/window-host.log: which windows opened, closed or had
    to be repaired. print() is not enough here: under the frozen launcher it
    can go nowhere at all."""
    try:
        with open(HOST_LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S") + "  " + message + "\n")
    except Exception:
        pass


def keep_main_shown_at_start(seconds=20.0):
    """Make sure the main window really is on screen after a launch.

    THE BUG THIS FIXES: the restart relaunches through launch.vbs, which starts
    the launcher with a hidden show flag (WshShell.Run style 0). Windows
    applies the launching program's show flag to the first window a process
    shows, which is the main planner, so after every restart it came back
    minimized or hidden and only the widget appeared.

    Watches for the first `seconds` (WebView2 can still be settling) and
    restores it whenever it is hidden or minimized, straight through Win32.
    Stops early once it has stayed up for a few seconds."""
    started = time.monotonic()
    good_since = None
    repaired = 0
    while time.monotonic() - started < seconds:
        time.sleep(0.4)
        try:
            hwnd = _main_hwnd()
            if not hwnd or main_window not in webview.windows:
                continue
            if user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd) and user32.IsZoomed(hwnd):
                # Seen up once: from here on a minimize is the user's, so stop
                # watching or this fights their minimize button for 20 s.
                break
            good_since = None
            repaired += 1
            host_log("main window came up %s; maximizing it" % (
                "minimized" if user32.IsIconic(hwnd)
                else "hidden" if not user32.IsWindowVisible(hwnd) else "not maximized"))
            # It always starts filling the screen (SW_SHOWMAXIMIZED also
            # un-hides and un-minimizes it).
            user32.ShowWindowAsync(hwnd, 3)
            user32.SetForegroundWindow(hwnd)
        except Exception as e:
            host_log("checking the main window failed: %s" % e)
    host_log("main window check done (%d repair(s))" % repaired)


def on_widget_closing():
    """Closing the widget while the main window is hidden quits the app.

    Otherwise an invisible main window would keep the process (and its memory,
    and the launcher mutex) alive with nothing on screen to close. This is also
    what lets a restart finish: it posts WM_CLOSE to both windows, the main one
    hides, and this then takes everything down so the relaunch is not blocked.
    """
    global _widget_closed
    _widget_closed = True
    host_log("widget closing (main hidden: %s)" % _main_is_hidden())
    if main_window is not None and main_window in webview.windows and _main_is_hidden():
        threading.Thread(target=main_window.destroy, daemon=True).start()
    if _orb is not None:
        _orb.close()
    return True


# ── Floating orb ──────────────────────────────────────────────────────────────
# A tiny always-on-top dot (planner_orb.py) that the widget tucks into. With it
# on, the widget is hidden until wanted:
#
#   rest the mouse on the orb  -> the widget peeks out beside it, and goes
#                                 again once the mouse leaves both
#   click                      -> the widget opens and stays (click again: away)
#   right-click                -> the assistant, in the widget's place
#   double-click               -> the full planner
#   drag                       -> move it; it snaps to a screen edge nearby
#
# "Hidden" is DWM cloaking, not SW_HIDE. A cloaked window is invisible, takes
# no clicks and has no taskbar button, but the page inside never learns it was
# hidden: it keeps its timers and its live data, so showing it again is
# instant, and none of the hidden-page problems refresh_webview_visibility
# exists for can happen.

ORB_STATE_PATH = os.path.join(_BASE_DIR, "database", "orb.json")
dwmapi = ctypes.WinDLL("dwmapi")
dwmapi.DwmSetWindowAttribute.argtypes = [ctypes.c_void_p, ctypes.wintypes.DWORD, ctypes.c_void_p, ctypes.wintypes.DWORD]
user32.GetForegroundWindow.restype = ctypes.c_void_p
DWMWA_CLOAK = 13
PEEK_MARGIN = 14       # px of slack around the widget and orb before a peek counts as left
PEEK_LEAVE_S = 0.35    # how long outside before it goes
WIDGET_GAP = 10        # px between the orb and the widget beside it

_orb = None
_orb_enabled = False
_orb_mode = None        # None (tucked), 'peek', 'pinned' or 'assistant'
_orb_lock = threading.RLock()
_peek_engaged = False   # the peeking widget was clicked into
_js_lock = threading.Lock()


def _load_orb_state():
    try:
        with open(ORB_STATE_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _save_orb_state(**changes):
    try:
        d = _load_orb_state()
        d.update(changes)
        os.makedirs(os.path.dirname(ORB_STATE_PATH), exist_ok=True)
        tmp = ORB_STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f)
        os.replace(tmp, ORB_STATE_PATH)
    except Exception as e:
        print("Failed to save orb state:", e)


def set_cloak(hwnd, on):
    try:
        v = ctypes.c_int(1 if on else 0)
        dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, ctypes.byref(v), ctypes.sizeof(v))
    except Exception as e:
        print("Failed to cloak the widget:", e)


def _widget_hwnd():
    try:
        return int(window.native.Handle.ToInt64())
    except Exception:
        return 0


def _widget_js(cmd):
    """Tell the widget page what just happened (it animates in, opens the
    assistant...). evaluate_js waits on the GUI thread, so never on ours."""
    def run():
        with _js_lock:
            try:
                window.evaluate_js("window.__plannerOrb && window.__plannerOrb(%s)" % json.dumps(cmd))
            except Exception as e:
                print("Failed to reach the widget page:", e)
    threading.Thread(target=run, daemon=True).start()


def _rect(hwnd):
    rc = ctypes.wintypes.RECT()
    if hwnd and user32.GetWindowRect(hwnd, ctypes.byref(rc)):
        return rc.left, rc.top, rc.right, rc.bottom
    return None


def _place_widget_beside_orb(hwnd):
    """Open towards the middle of the screen, centred on the orb, never off it."""
    orb_rc = _orb.rect() if _orb else None
    wrc = _rect(hwnd)
    if not orb_rc or not wrc:
        return
    w, h = wrc[2] - wrc[0], wrc[3] - wrc[1]
    ocx, ocy = (orb_rc[0] + orb_rc[2]) // 2, (orb_rc[1] + orb_rc[3]) // 2
    mon = user32.MonitorFromPoint(ctypes.wintypes.POINT(ocx, ocy), MONITOR_DEFAULTTONEAREST)
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    if not mon or not user32.GetMonitorInfoW(mon, ctypes.byref(info)):
        return
    wa = info.rcWork
    scale = _orb.scale if _orb else 1.0
    gap = int(WIDGET_GAP * scale)
    w = min(w, wa.right - wa.left)
    h = min(h, wa.bottom - wa.top)
    if ocx > (wa.left + wa.right) // 2:
        x = orb_rc[0] - gap - w
    else:
        x = orb_rc[2] + gap
    y = ocy - h // 2
    x = min(max(x, wa.left), wa.right - w)
    y = min(max(y, wa.top), wa.bottom - h)
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    user32.SetWindowPos(hwnd, 0, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE)


def show_widget(mode):
    """Bring the widget out of the orb in `mode`. Already out: just switch."""
    global _orb_mode, _peek_engaged
    with _orb_lock:
        hwnd = _widget_hwnd()
        if not hwnd:
            return
        was = _orb_mode
        _orb_mode = mode
        _peek_engaged = False
        if was != mode:
            host_log("widget out: %s (was %s)" % (mode, was))
        if was is None:
            _place_widget_beside_orb(hwnd)
            _widget_js("assistant" if mode == "assistant" else "show")
            set_cloak(hwnd, False)
        # Minimized meanwhile (Win+D, Show desktop): bring it back too, or it
        # would be "out" yet nowhere on screen.
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 4)  # SW_SHOWNOACTIVATE restores it
        elif mode == "assistant" and was != "assistant":
            _widget_js("assistant")
        elif mode != "assistant" and was == "assistant":
            _widget_js("show")
        if mode == "assistant":
            # The click on the orb was our process's input, so Windows lets us
            # hand the widget the keyboard: type straight into the assistant.
            user32.SetForegroundWindow(hwnd)


def hide_widget():
    global _orb_mode, _peek_engaged
    with _orb_lock:
        if _orb_mode is None:
            return
        host_log("widget tucked away (was %s)" % _orb_mode)
        _orb_mode = None
        _peek_engaged = False
        hwnd = _widget_hwnd()
        if hwnd:
            set_cloak(hwnd, True)
        _widget_js("hide")


def _orb_click():
    hwnd = _widget_hwnd()
    if _orb_mode in (None, "peek"):
        show_widget("pinned")
    elif hwnd and user32.IsIconic(hwnd):
        # Out, but minimized behind the scenes: a click means "show me".
        show_widget(_orb_mode)
    else:
        hide_widget()


def _orb_double_click():
    hide_widget()
    show_main_window()


def _orb_right_click():
    if _orb_mode == "assistant":
        hide_widget()
    else:
        show_widget("assistant")


def _orb_middle_click():
    """Middle-click (the wheel) on the orb: talk to the assistant, or stop.
    A peeking widget goes away first: voice mode is the orb on its own."""
    with _orb_lock:
        if _orb_mode == "peek":
            hide_widget()
    host_log("orb voice toggle")
    _widget_js("voice-toggle")


def _orb_voice_tap():
    """A left click on the orb while in voice mode (stop talking / done / mute)."""
    _widget_js("voice-tap")


def _orb_hover():
    if _orb_mode is None and not (_orb is not None and _orb.voice_mode):
        show_widget("peek")


def _orb_drag_start():
    if _orb_mode == "peek":
        hide_widget()


def _orb_moved():
    with _orb_lock:
        if _orb_mode is not None:
            _place_widget_beside_orb(_widget_hwnd())


def _inside(pt, rc, margin):
    return rc and rc[0] - margin <= pt.x < rc[2] + margin and rc[1] - margin <= pt.y < rc[3] + margin


def _peek_watch_loop():
    """Puts a peeking widget away once the mouse has left it and the orb.

    Polls the cursor (two cheap Win32 calls) instead of hooking the mouse: a
    global hook would sit in the path of every mouse move on the PC."""
    global _peek_engaged
    left_at = None
    pt = ctypes.wintypes.POINT()
    while True:
        if _orb_mode != "peek":
            left_at = None
            time.sleep(0.15)
            continue
        time.sleep(0.04)
        hwnd = _widget_hwnd()
        if not hwnd or not user32.GetCursorPos(ctypes.byref(pt)):
            continue
        scale = _orb.scale if _orb else 1.0
        margin = int(PEEK_MARGIN * scale)
        # Only a click on the orb pins the widget. Clicking INSIDE a peeking
        # widget (a task, "show more") used to keep it open until focus moved,
        # which read as pinning itself for no reason.
        if _inside(pt, _rect(hwnd), margin) or _inside(pt, _orb.rect() if _orb else None, margin):
            left_at = None
            continue
        now = time.monotonic()
        if left_at is None:
            left_at = now
        elif now - left_at >= PEEK_LEAVE_S:
            with _orb_lock:
                if _orb_mode == "peek":
                    hide_widget()
            left_at = None


def set_orb_enabled(on):
    """Orb mode on: the widget tucks into the orb. Off: it is a normal window
    again, back where it was before."""
    global _orb_enabled, _orb_mode
    with _orb_lock:
        if on == _orb_enabled:
            return
        _orb_enabled = on
        _save_orb_state(enabled=on)
        hwnd = _widget_hwnd()
        if on:
            rc = _rect(hwnd)
            if rc:
                _save_orb_state(widgetFree=list(rc))
            _orb_mode = "pinned"  # so hide_widget() below runs
            hide_widget()
            if _orb is not None:
                _orb.set_visible(True)
        else:
            if _orb is not None:
                _orb.set_visible(False)
            free = _load_orb_state().get("widgetFree")
            if hwnd and isinstance(free, list) and len(free) == 4:
                l, t, r, b = (int(v) for v in free)
                user32.SetWindowPos(hwnd, 0, l, t, r - l, b - t, 0x0004 | 0x0010)
            _orb_mode = None
            if hwnd:
                set_cloak(hwnd, False)
            _widget_js("show")
        # Taskbar button: none in orb mode (the orb is its button), back
        # again without it. The style only takes effect across a hide/show,
        # which apply_taskbar_presence does safely.
        if hwnd:
            apply_taskbar_presence(hwnd)


WIDGET_ZOOM_DEFAULT = 0.85


def apply_widget_zoom():
    """The widget drawn smaller than the main window: it is a side panel.

    85% by default. Ctrl+scroll or Ctrl +/- in the widget still adjusts it,
    and whatever was chosen is remembered (database/orb.json)."""
    try:
        from System import Action, EventHandler
        form = window.native
        try:
            zoom = float(_load_orb_state().get("widgetZoom", WIDGET_ZOOM_DEFAULT))
        except Exception:
            zoom = WIDGET_ZOOM_DEFAULT
        zoom = min(2.0, max(0.5, zoom))

        def apply():
            control = form.browser.webview
            control.ZoomFactor = zoom
            if not getattr(apply_widget_zoom, "_hooked", False):
                apply_widget_zoom._hooked = True

                def changed(sender, args):
                    z = round(float(sender.ZoomFactor), 3)
                    threading.Thread(target=_save_orb_state, kwargs={"widgetZoom": z}, daemon=True).start()

                control.ZoomFactorChanged += EventHandler(changed)

        form.Invoke(Action(apply))
    except Exception as e:
        print("Failed to set the widget zoom:", e)


def start_orb():
    """Create the orb (shown only in orb mode) and its peek watcher."""
    global _orb
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("planner_orb", os.path.join(_BASE_DIR, "planner_orb.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _orb = mod.Orb(
            ORB_STATE_PATH,
            on_click=_orb_click,
            on_double_click=_orb_double_click,
            on_right_click=_orb_right_click,
            on_hover=_orb_hover,
            on_drag_start=_orb_drag_start,
            on_moved=_orb_moved,
            on_middle_click=_orb_middle_click,
            on_voice_tap=_orb_voice_tap,
        )
        _orb.set_visible(_orb_enabled)
        _orb.start()
        threading.Thread(target=_peek_watch_loop, name="orb-peek-watch", daemon=True).start()
    except Exception as e:
        print("Failed to start the orb:", e)
        _orb = None


def run_windows(show_main=True):
    """Open the main planner window and the widget in THIS process, both on one
    WebView2 environment. `show_main=False` (the widget launched on its own by
    the server) still creates the main window, hidden, so the widget's open
    button has something to show."""
    global window, main_window, _orb_enabled
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
        maximized=show_main,  # opens filling the screen
        js_api=MainApi(),
    )
    main_window.events.closing += on_main_closing
    main_window.events.loaded += on_main_loaded
    main_window.events.shown += lambda: set_form_icon(main_window, MAIN_ICON_PATH)
    host_log("starting windows (show_main=%s)" % show_main)
    if show_main:
        threading.Thread(target=keep_main_shown_at_start, name="main-shown-check", daemon=True).start()

    # The orb first: whether the widget starts tucked away depends on it. Orb
    # mode is on unless it was switched off, and never on without a working
    # orb (a cloaked widget with no orb would be unreachable).
    _orb_enabled = _load_orb_state().get("enabled", True) is not False
    start_orb()
    if _orb is None or not _orb.hwnd:
        _orb_enabled = False
        if _orb is not None:
            _orb.set_visible(False)

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
    window.events.loaded += apply_widget_zoom

    # Start the webview window loop with custom application icon. A persistent
    # profile (not private mode) keeps the login cookie across restarts.
    base_dir = os.path.dirname(os.path.abspath(__file__))
    webview.start(
        icon=os.path.join(base_dir, 'app-icon.ico'),
        private_mode=False,
        storage_path=os.path.join(base_dir, '.webview-profile')
    )
    host_log("all windows closed; window host exiting")
    if _quit_everything:
        stop_background()
    # Then really exit. With every window closed the process still lingered
    # (interpreter/.NET shutdown never finished), so each restart waited and
    # finally force-killed it. WebView2 has already flushed its profile by
    # now (that happens as each window closes); give its browser processes a
    # moment to wind down, then leave.
    time.sleep(1.5)
    os._exit(0)

if __name__ == '__main__':
    # Run directly (the server's "open widget" route): the widget is what was
    # asked for, so the main window starts hidden.
    run_windows(show_main=False)
