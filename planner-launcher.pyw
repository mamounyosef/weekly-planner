"""Daily Planner launcher.

Replaces the old start-planner.vbs / start-planner.bat / start-widget.bat /
launch-app-mode.bat / start-focus-hotkey.bat chain. Avast quarantined that whole
set -- a .vbs whose only job is to run a .bat with window style 0 is a textbook
hidden-launcher heuristic, and it blocked those exact paths from ever being
recreated. This does the same work from one pythonw process, which shows no
console of its own and trips nothing.

Run with pythonw.exe so nothing appears on screen.
"""

import ctypes
import ctypes.wintypes
import os
import subprocess
import sys
import time
import urllib.request

# Static imports to ensure PyInstaller bundles dependencies for widget-window.py
import secrets
import threading
try:
    import webview
except ImportError:
    pass

def _root():
    """The repo folder, whether running as a .pyw or as the frozen .exe.

    Frozen, `__file__` points inside PyInstaller's temporary extraction folder,
    which contains none of the things this launcher needs (the venv, the widget,
    node_modules). `sys.executable` is the .exe itself, and the .exe is built to
    sit in the repo root, so that is the anchor.
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


ROOT = _root()


def _attach_stdio():
    """Give print() somewhere to go when there is no console.

    A real pythonw.exe hands the process no console at all, so sys.stdout and
    sys.stderr are None and every print() raises AttributeError. All of the
    prints below sit inside `except` blocks, so that would turn a handled,
    survivable error into a crashed launcher: no app window, no widget, no
    server. This never bit before only because .venv-launcher's pythonw.exe
    used to be a stub that re-launched the CONSOLE interpreter -- the same stub
    that flashed a terminal on screen every time the scheduled tasks ran.

    Log to a file rather than to os.devnull: these messages are the only record
    of a failed startup step, and a launcher that fails silently is exactly how
    the last boot problem went unnoticed for days.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    stream = None
    try:
        path = os.path.join(ROOT, "database", "launcher.log")
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

URL = "http://127.0.0.1:5173"

# Keeps every child process from flashing a console window.
NO_WINDOW = 0x08000000
# The dev server has to outlive this launcher, so it gets its own process group.
# NOT DETACHED_PROCESS: that denies the child a console, so npx allocates its own
# and a terminal appears on screen. CREATE_NO_WINDOW suppresses it outright.
SERVER_FLAGS = NO_WINDOW | 0x00000200  # | CREATE_NEW_PROCESS_GROUP

SERVER_LOG = os.path.join(os.environ.get("TEMP", "."), "planner-server.log")

# Avast also quarantined C:\ProgramData\anaconda3\pythonw.exe and blocks that
# path, so .venv-launcher holds our own windowless interpreter. It is a venv
# built with --system-site-packages, so it still sees anaconda's packages
# (pywebview, which the widget needs).
PYTHONW = os.path.join(ROOT, ".venv-launcher", "Scripts", "pythonw.exe")

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# Keep reference to mutex handle so it lives for launcher lifecycle
_launcher_mutex = None


def acquire_launcher_mutex():
    """Ensure only one launcher process runs at a time during system boot."""
    global _launcher_mutex
    ERROR_ALREADY_EXISTS = 183
    _launcher_mutex = kernel32.CreateMutexW(None, False, "Global\\PlannerLauncherLock")
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        return False
    return True


def find_planner_windows():
    """Find the top-level 'Daily Planner' windows, INCLUDING a hidden one.

    Closing the main window only hides it (see on_main_closing in
    widget-window.py), so a hidden planner window is the normal "closed" state
    and must still be found to be shown again. Hidden windows are only counted
    when they are the WinForms form pywebview creates, so an unrelated hidden
    window that happens to share the title is never picked up.
    """
    hwnds = []

    def enum_proc(hwnd, lparam):
        if user32.IsWindow(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                if buff.value == "Daily Planner":
                    if user32.IsWindowVisible(hwnd):
                        hwnds.append(hwnd)
                    else:
                        cls = ctypes.create_unicode_buffer(256)
                        user32.GetClassNameW(hwnd, cls, 256)
                        if cls.value.startswith("WindowsForms"):
                            hwnds.append(hwnd)
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    hdesk = user32.OpenInputDesktop(0, False, 0x01FF)
    if hdesk:
        try:
            user32.EnumDesktopWindows(hdesk, WNDENUMPROC(enum_proc), 0)
        finally:
            user32.CloseDesktop(hdesk)
    else:
        user32.EnumWindows(WNDENUMPROC(enum_proc), 0)

    return hwnds


def bring_window_to_front(hwnd):
    """Restore and bring the specified window to the foreground."""
    SW_RESTORE = 9
    SW_SHOW = 5
    try:
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, SW_RESTORE)
        else:
            user32.ShowWindow(hwnd, SW_SHOW)
            # WebView2 can come back blank white after its host window was
            # hidden; a one-pixel size nudge forces it to lay out and redraw.
            rect = ctypes.wintypes.RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                w, h = rect.right - rect.left, rect.bottom - rect.top
                flags = 0x0002 | 0x0004 | 0x0010  # NOMOVE | NOZORDER | NOACTIVATE
                user32.SetWindowPos(hwnd, 0, 0, 0, w, h + 1, flags)
                user32.SetWindowPos(hwnd, 0, 0, 0, w, h, flags)

        fore_hwnd = user32.GetForegroundWindow()
        fore_thread = user32.GetWindowThreadProcessId(fore_hwnd, None) if fore_hwnd else 0
        app_thread = kernel32.GetCurrentThreadId()

        if fore_thread and fore_thread != app_thread:
            user32.AttachThreadInput(fore_thread, app_thread, True)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            user32.AttachThreadInput(fore_thread, app_thread, False)
        else:
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
    except Exception as e:
        print("Failed to bring window to front:", e)


def close_excess_windows(hwnds):
    """If more than one Daily Planner window is open, keep the first and close the others."""
    WM_CLOSE = 0x0010
    if len(hwnds) > 1:
        for extra_hwnd in hwnds[1:]:
            try:
                user32.PostMessageW(extra_hwnd, WM_CLOSE, 0, 0)
            except Exception:
                pass


def pythonw():
    """The interpreter that runs the widget and the focus hotkey.

    python.exe, not pythonw.exe: every spawn here passes CREATE_NO_WINDOW, which
    suppresses the console outright, and the console-mode binary keeps print()
    working in the widget and the hotkey. (This used to matter more: the venv's
    pythonw.exe was a stub that re-launched the console interpreter WITHOUT our
    CREATE_NO_WINDOW, so it flashed a terminal. tools/fix-venv-launcher.ps1
    replaced both stubs with the real interpreters.)

    Resolved in order of preference rather than hardcoded. This used to return
    an absolute Anaconda path, which made a second-party install that the
    planner does not own into a hard dependency: if Anaconda were moved or
    uninstalled, the side widget and the focus hotkey would silently never
    start, with no error anywhere. The project's own venv is tried first, so the
    planner depends on something it ships and controls.
    """
    candidates = [venv_base_python()]
    # The venv's own python.exe is a real interpreter again (see
    # tools/fix-venv-launcher.ps1); before that it was a REDIRECTOR that spawned
    # the base interpreter as a child, and the child, being created by the stub
    # rather than by us, did not inherit CREATE_NO_WINDOW and flashed a console.
    # Kept second so the base install stays the primary path either way.
    candidates.append(os.path.join(ROOT, ".venv-launcher", "Scripts", "python.exe"))
    # Not when frozen: sys.executable is then the launcher .exe itself, which
    # would re-run the launcher instead of the hotkey or the toast handler.
    if not getattr(sys, "frozen", False):
        candidates.append(sys.executable)
    for exe in candidates:
        if exe and os.path.exists(exe):
            return exe
    # Last resort: whatever PATH offers. Better a console flash than no widget.
    return "python.exe"


def venv_base_python():
    """The real interpreter behind .venv-launcher, read from its own config.

    The venv is built with --system-site-packages precisely because pywebview
    (which the side widget needs) lives in the base installation, so running the
    base interpreter directly still sees everything the widget imports.

    Read rather than hardcoded. This path used to be written out in full, which
    silently tied the side widget and the focus hotkey to an Anaconda install
    the planner does not own: move or uninstall it and both would stop starting
    with no error anywhere.
    """
    cfg = os.path.join(ROOT, ".venv-launcher", "pyvenv.cfg")
    try:
        with open(cfg, "r", encoding="utf-8") as f:
            for line in f:
                key, _, value = line.partition("=")
                if key.strip() == "executable":
                    return value.strip()
    except Exception:
        pass
    # Older venvs record only `home`, the folder holding the interpreter.
    try:
        with open(cfg, "r", encoding="utf-8") as f:
            for line in f:
                key, _, value = line.partition("=")
                if key.strip() == "home":
                    return os.path.join(value.strip(), "python.exe")
    except Exception:
        pass
    return None


def spawn(args):
    subprocess.Popen(
        args,
        cwd=ROOT,
        creationflags=NO_WINDOW,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def server_up():
    try:
        with urllib.request.urlopen(URL, timeout=2):
            return True
    except Exception:
        return False


def wait_for_server(timeout=120):
    """Block until the dev server answers. A fixed delay used to lose this race
    on a slow cold start and the widget would never appear."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if server_up():
            return True
        time.sleep(0.5)
    return False


def register_notification_protocol():
    """Make the toast buttons work.

    Windows toasts fired by the notification engine put `plannernotify:` links
    on their buttons. Registering the handler here rather than in an installer
    means the association repairs itself on every boot, so Snooze and Done can
    never quietly stop working after a Python or profile change.
    """
    try:
        agent = os.path.join(ROOT, "tools", "notify-action.pyw")
        if os.path.exists(agent):
            subprocess.Popen(
                [pythonw(), agent, "--register"],
                cwd=ROOT,
                creationflags=NO_WINDOW,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    except Exception as e:
        print("Failed to register notification protocol:", e)


def main():
    if not acquire_launcher_mutex():
        # A second launcher started only to focus the window (a toast was
        # clicked) still does that job, it just does not start anything.
        if "--focus" in sys.argv:
            existing = find_planner_windows()
            if existing:
                bring_window_to_front(existing[0])
        return

    focus_only = "--focus" in sys.argv
    if focus_only:
        existing = find_planner_windows()
        if existing:
            bring_window_to_front(existing[0])
            close_excess_windows(existing)
            return

    register_notification_protocol()

    if not server_up():
        # Output goes to a log file, not DEVNULL — if the server ever dies on
        # boot there needs to be something to read afterwards.
        log = open(SERVER_LOG, "ab", buffering=0)
        node_exe = "node.exe"
        vite_js = os.path.join(ROOT, "artifacts", "weekly-planner", "node_modules", "vite", "bin", "vite.js")
        
        # Bypass npx.cmd and pnpm.cmd to avoid cmd.exe wrappers that can flash consoles on Windows.
        # Running node directly inherits CREATE_NO_WINDOW seamlessly.
        subprocess.Popen(
            [node_exe, vite_js, "--config", "vite.config.ts", "--host", "0.0.0.0"],
            cwd=os.path.join(ROOT, "artifacts", "weekly-planner"),
            creationflags=SERVER_FLAGS,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            close_fds=True,
        )

    wait_for_server()

    # A widget started on its own by the server already hosts a (hidden) main
    # window; show that one instead of opening a second pair.
    existing_windows = find_planner_windows()
    if existing_windows:
        bring_window_to_front(existing_windows[0])
        close_excess_windows(existing_windows)

    # Spawn the hotkey process using local python (no window, no taskbar icon)
    py = pythonw()
    spawn([py, os.path.join(ROOT, "focus-hotkey.py")])

    if existing_windows:
        return

    # The main window and the widget both run in THIS process, on one WebView2
    # environment (they used to be a Chrome window plus a separate widget
    # process), so they share one taskbar group and one set of browser processes.
    import importlib.util
    spec = importlib.util.spec_from_file_location("widget_window", os.path.join(ROOT, "widget-window.py"))
    widget_module = importlib.util.module_from_spec(spec)
    sys.modules["widget_window"] = widget_module
    spec.loader.exec_module(widget_module)
    widget_module.run_windows()


if __name__ == "__main__":
    main()
