import os
import secrets

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
])

import webview
import ctypes
import ctypes.wintypes
import threading
import time

_resizing = False
_old_wndproc = None
_new_wndproc = None
_always_on_top_enabled = True

# WebView2 and the Chrome-based main app have separate cookie stores. This is a
# random pairing capability for this *window*, not an authentication token: the
# local server will only attach it to an account after the signed-in main app
# explicitly approves it. Keeping the real session out of this command line and
# URL avoids duplicating credentials between the two browser engines.
WIDGET_PAIRING_ID = secrets.token_hex(32)


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



class Api:
    def minimize(self):
        window.minimize()
    def close(self):
        window.destroy()
    
    def start_drag(self):
        try:
            hwnd = int(window.native.Handle.ToInt64())
            # Release mouse capture from the child browser control
            user32.ReleaseCapture()
            # Post WM_SYSCOMMAND (0x0112) with SC_MOVE + HTCAPTION (0xF012) to start OS-level window drag asynchronously (prevents UI deadlock)
            user32.PostMessageW(hwnd, 0x0112, 0xF012, 0)
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
        # If the main app window is already open, bring it to the front rather than opening another copy
        hdesk = user32.OpenInputDesktop(0, False, 0x01FF)
        hwnds = []
        def enum_proc(hwnd, lparam):
            if user32.IsWindow(hwnd) and user32.IsWindowVisible(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buff = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buff, length + 1)
                    if buff.value == 'Daily Planner':
                        hwnds.append(hwnd)
            return True
        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
        if hdesk:
            try:
                user32.EnumDesktopWindows(hdesk, WNDENUMPROC(enum_proc), 0)
            finally:
                user32.CloseDesktop(hdesk)
        else:
            user32.EnumWindows(WNDENUMPROC(enum_proc), 0)

        if hwnds:
            SW_RESTORE = 9
            SW_SHOW = 5
            try:
                main_hwnd = hwnds[0]
                if user32.IsIconic(main_hwnd):
                    user32.ShowWindow(main_hwnd, SW_RESTORE)
                else:
                    user32.ShowWindow(main_hwnd, SW_SHOW)
                user32.BringWindowToTop(main_hwnd)
                user32.SetForegroundWindow(main_hwnd)
                if len(hwnds) > 1:
                    for extra in hwnds[1:]:
                        user32.PostMessageW(extra, 0x0010, 0, 0)
                return
            except Exception as e:
                print("Failed to focus existing planner window:", e)

        import os
        import json
        import subprocess
        chrome_path1 = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        chrome_path2 = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
        edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
        # This opens the main browser app. Keep it on its canonical hostname so
        # Chrome reuses the persistent planner_session cookie from the launcher.
        url = "http://localhost:5173"
        user_data = r"D:\My Projects\weekly-planner\.chrome-profile"
        awake_flags = [
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion,SessionRestore",
            "--hide-crash-restore-bubble",
            "--disable-session-crashed-bubble",
            "--no-first-run",
            "--no-default-browser-check",
        ]

        try:
            default_dir = os.path.join(user_data, "Default")
            pref_path = os.path.join(default_dir, "Preferences")
            if os.path.exists(pref_path):
                with open(pref_path, "r", encoding="utf-8-sig") as f:
                    pref_data = json.load(f)
                mod = False
                if not isinstance(pref_data.get("profile"), dict):
                    pref_data["profile"] = {}
                if pref_data["profile"].get("exit_type") != "Normal":
                    pref_data["profile"]["exit_type"] = "Normal"
                    mod = True
                if pref_data["profile"].get("exited_cleanly") is not True:
                    pref_data["profile"]["exited_cleanly"] = True
                    mod = True
                if not isinstance(pref_data.get("session"), dict):
                    pref_data["session"] = {}
                if pref_data["session"].get("restore_on_startup") != 1:
                    pref_data["session"]["restore_on_startup"] = 1
                    mod = True
                if mod:
                    with open(pref_path, "w", encoding="utf-8") as f:
                        json.dump(pref_data, f)
            sessions_dir = os.path.join(default_dir, "Sessions")
            if os.path.exists(sessions_dir):
                for fname in os.listdir(sessions_dir):
                    fpath = os.path.join(sessions_dir, fname)
                    if os.path.isfile(fpath):
                        try:
                            os.remove(fpath)
                        except Exception:
                            pass
        except Exception:
            pass
        
        if os.path.exists(chrome_path1):
            subprocess.Popen([chrome_path1, f"--app={url}", f"--user-data-dir={user_data}"] + awake_flags)
        elif os.path.exists(chrome_path2):
            subprocess.Popen([chrome_path2, f"--app={url}", f"--user-data-dir={user_data}"] + awake_flags)
        elif os.path.exists(edge_path):
            subprocess.Popen([edge_path, f"--app={url}", f"--user-data-dir={user_data}"] + awake_flags)
        else:
            import webbrowser
            webbrowser.open(url)

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

def already_running():
    """True if a widget window is already open — launching the app twice used to
    stack up duplicate widgets, each syncing and sounding independently."""
    ERROR_ALREADY_EXISTS = 183
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateMutexW(None, False, 'Global\\PlannerWidgetWindow')
    return ctypes.get_last_error() == ERROR_ALREADY_EXISTS


if __name__ == '__main__':
    if already_running():
        import sys as _sys
        _sys.exit(0)
    api = Api()
    # Create a standard window (not frameless), which we then border-strip in on_shown
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
    
    # Start the webview window loop with custom application icon
    webview.start(icon='D:\\My Projects\\weekly-planner\\app-icon.ico')
