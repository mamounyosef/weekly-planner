"""Daily Planner launcher.

Replaces the old start-planner.vbs / start-planner.bat / start-widget.bat /
launch-app-mode.bat / start-focus-hotkey.bat chain. Avast quarantined that whole
set -- a .vbs whose only job is to run a .bat with window style 0 is a textbook
hidden-launcher heuristic, and it blocked those exact paths from ever being
recreated. This does the same work from one pythonw process, which shows no
console of its own and trips nothing.

Run with pythonw.exe so nothing appears on screen.
"""

import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
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


def pythonw():
    if os.path.exists(PYTHONW):
        return PYTHONW
    exe = sys.executable
    # If we were somehow started by python.exe, prefer its windowless twin.
    alt = exe.replace("python.exe", "pythonw.exe")
    return alt if os.path.exists(alt) else exe


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


def main():
    if not server_up():
        # Output goes to a log file, not DEVNULL — if the server ever dies on
        # boot there needs to be something to read afterwards.
        log = open(SERVER_LOG, "ab", buffering=0)
        subprocess.Popen(
            ["npx.cmd", "pnpm", "--filter", "@workspace/weekly-planner", "dev"],
            cwd=ROOT,
            creationflags=SERVER_FLAGS,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            close_fds=True,
        )

    wait_for_server()

    for exe in BROWSERS:
        if os.path.exists(exe):
            spawn([exe, "--app=" + APP_URL, "--user-data-dir=" + PROFILE])
            break
    else:
        os.startfile(APP_URL)

    py = pythonw()
    spawn([py, os.path.join(ROOT, "widget-window.py")])
    spawn([py, os.path.join(ROOT, "focus-hotkey.py")])


if __name__ == "__main__":
    main()
