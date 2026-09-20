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
import json
import os
import subprocess
import sys
import time
import urllib.request

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
URL = "http://127.0.0.1:5173"
APP_URL = "http://localhost:5173"
PROFILE = os.path.join(ROOT, ".chrome-profile")

# Keeps every child process from flashing a console window.
NO_WINDOW = 0x08000000
# The dev server has to outlive this launcher, so it gets its own process group.
# NOT DETACHED_PROCESS: that denies the child a console, so npx allocates its own
# and a terminal appears on screen. CREATE_NO_WINDOW suppresses it outright.
SERVER_FLAGS = NO_WINDOW | 0x00000200  # | CREATE_NEW_PROCESS_GROUP

SERVER_LOG = os.path.join(os.environ.get("TEMP", "."), "planner-server.log")

# Chrome puts a window nobody is looking at to sleep: timers in a minimised or
# fully-covered page are throttled to roughly once a minute. This is not a
# background tab in a normal browser — it is the planner itself, and being asleep
# means the clock stops, the desk controller stops publishing to the LCD, and a
# pending countdown or away-timeout freezes until the window is clicked. These
# flags only take effect because the app runs from its own --user-data-dir, and
# so is a fresh Chrome instance rather than a window joining an existing one.
AWAKE_FLAGS = [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    # The above three predate "intensive throttling", which is the one that
    # imposes the once-a-minute ceiling after five minutes hidden.
    "--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion,SessionRestore,"
    # Chrome downloads its on-device language model into whatever profile it
    # is running from. In this one it is 4 GB of a repo folder, spent so a
    # kiosk window showing a calendar can do nothing with it.
    "OptimizationGuideOnDeviceModel,OptimizationGuideModelDownloading,"
    "OptimizationHints,TextSafetyClassifier",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--no-first-run",
    "--no-default-browser-check",
    # DO NOT add memory flags here. On 2026-09-20 --renderer-process-limit=1,
    # --process-per-site and friends were tried: they saved about 30 MB out of
    # 838 (noise) and left the app window rendering BLANK. The memory is in the
    # Chrome browser process, the GPU process and the service worker, none of
    # which those flags touch. It is not a trade worth making.
]

BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

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
    """Find all top-level desktop windows with title 'Daily Planner'."""
    hwnds = []

    def enum_proc(hwnd, lparam):
        if user32.IsWindow(hwnd) and user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                if buff.value == "Daily Planner":
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


def sanitize_chrome_profile(profile_path):
    """Clean up crashed session flags and stale session files so Chrome doesn't
    restore the previous session in addition to opening the --app URL."""
    try:
        default_dir = os.path.join(profile_path, "Default")
        pref_path = os.path.join(default_dir, "Preferences")
        if os.path.exists(pref_path):
            try:
                with open(pref_path, "r", encoding="utf-8-sig") as f:
                    data = json.load(f)

                modified = False
                if not isinstance(data.get("profile"), dict):
                    data["profile"] = {}
                
                if data["profile"].get("exit_type") != "Normal":
                    data["profile"]["exit_type"] = "Normal"
                    modified = True
                if data["profile"].get("exited_cleanly") is not True:
                    data["profile"]["exited_cleanly"] = True
                    modified = True

                if not isinstance(data.get("session"), dict):
                    data["session"] = {}

                if data["session"].get("restore_on_startup") != 1:
                    data["session"]["restore_on_startup"] = 1
                    modified = True

                if modified:
                    with open(pref_path, "w", encoding="utf-8") as f:
                        json.dump(data, f)
            except Exception as e:
                print("Failed to update preferences:", e)

        # Clear stale Sessions files so Chrome doesn't revive previous session windows
        sessions_dir = os.path.join(default_dir, "Sessions")
        if os.path.exists(sessions_dir):
            for fname in os.listdir(sessions_dir):
                fpath = os.path.join(sessions_dir, fname)
                try:
                    if os.path.isfile(fpath):
                        os.remove(fpath)
                except Exception:
                    pass
    except Exception as e:
        print("Failed to sanitize chrome profile:", e)


def pythonw():
    """The interpreter that runs the widget and the focus hotkey.

    python.exe, not pythonw.exe: Avast quarantined the real pythonw.exe once,
    and the venv's proxy pythonw.exe spawns python.exe with a VISIBLE console.
    Every spawn here passes CREATE_NO_WINDOW, which suppresses the console
    outright, so the console-mode binary is both safer and quieter.

    Resolved in order of preference rather than hardcoded. This used to return
    an absolute Anaconda path, which made a second-party install that the
    planner does not own into a hard dependency: if Anaconda were moved or
    uninstalled, the side widget and the focus hotkey would silently never
    start, with no error anywhere. The project's own venv is tried first, so the
    planner depends on something it ships and controls.
    """
    candidates = [venv_base_python()]
    # The venv's own python.exe is a REDIRECTOR, not an interpreter: it spawns
    # the base interpreter as a child process. That costs a second process per
    # window and, worse, the child is created by the stub rather than by us, so
    # it does not inherit CREATE_NO_WINDOW and can flash a console. It is kept
    # only as a fallback, because a console flash still beats no widget.
    candidates.append(os.path.join(ROOT, ".venv-launcher", "Scripts", "python.exe"))
    # Not when frozen: sys.executable is then the launcher .exe itself, which
    # would re-run the launcher instead of the widget.
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

    # Check if a Daily Planner window is already open (e.g. from Windows App Restart)
    existing_windows = find_planner_windows()
    if existing_windows:
        bring_window_to_front(existing_windows[0])
        close_excess_windows(existing_windows)
    else:
        sanitize_chrome_profile(PROFILE)
        for exe in BROWSERS:
            if os.path.exists(exe):
                spawn([exe, "--app=" + APP_URL, "--user-data-dir=" + PROFILE] + AWAKE_FLAGS)
                break
        else:
            os.startfile(APP_URL)

    py = pythonw()
    spawn([py, os.path.join(ROOT, "widget-window.py")])
    spawn([py, os.path.join(ROOT, "focus-hotkey.py")])


if __name__ == "__main__":
    main()
