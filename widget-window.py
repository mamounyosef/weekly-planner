import webview
import ctypes
import ctypes.wintypes

_resizing = False
_old_wndproc = None
_new_wndproc = None

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
        import os
        import subprocess
        chrome_path1 = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        chrome_path2 = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
        edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
        url = "http://127.0.0.1:5173"
        user_data = r"D:\My Projects\weekly-planner\.chrome-profile"
        
        if os.path.exists(chrome_path1):
            subprocess.Popen([chrome_path1, f"--app={url}", f"--user-data-dir={user_data}"])
        elif os.path.exists(chrome_path2):
            subprocess.Popen([chrome_path2, f"--app={url}", f"--user-data-dir={user_data}"])
        elif os.path.exists(edge_path):
            subprocess.Popen([edge_path, f"--app={url}", f"--user-data-dir={user_data}"])
        else:
            import webbrowser
            webbrowser.open(url)

    def set_always_on_top(self, on_top):
        # SWP and HWND top-most constants
        HWND_TOPMOST = -1
        HWND_NOTOPMOST = -2
        SWP_NOMOVE = 0x0002
        SWP_NOSIZE = 0x0001
        SWP_SHOWWINDOW = 0x0040
        try:
            hwnd = int(window.native.Handle.ToInt64())
            target = HWND_TOPMOST if on_top else HWND_NOTOPMOST
            user32.SetWindowPos(hwnd, target, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
        except Exception as e:
            print("Failed to toggle top-most:", e)


# Win32 Constants
WM_NCHITTEST = 0x0084
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
        url='http://127.0.0.1:5173/widget',
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
