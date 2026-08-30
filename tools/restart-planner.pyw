"""Restart the whole planner: server, app window, widget and hotkey listener.

Started by the dev server when you press "Restart planner" in Settings. Run with
pythonw.exe so nothing appears on screen -- every child below is also created
with CREATE_NO_WINDOW, because the whole point is that a restart looks like the
app blinking, not like a terminal appearing.

WHY THIS IS A SEPARATE PROCESS
It has to outlive the thing it kills. If the server ran this inline it would be
shutting down its own process tree mid-request, and nothing would be left to
start it up again.

ORDER MATTERS
  1. Close the windows first, gracefully, so Chrome writes a clean session and
     does not offer to restore tabs on the way back up.
  2. Then the server -- by pid, NEVER as a tree. This script is spawned BY the
     server, so it is inside that tree: `taskkill /T` killed the killer, the
     server stayed down and nothing came back. Its wrapper processes exit on
     their own once the port holder is gone.
  3. Then WAIT for the port to actually be free. Windows holds a listening
     socket for a moment after the owner dies, and a launcher that starts too
     early sees "server already up", starts nothing, and leaves you with no
     planner at all.
  4. Only then relaunch.
"""

import ctypes
import ctypes.wintypes
import os
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAUNCHER = os.path.join(ROOT, "planner-launcher.pyw")
PYTHONW = os.path.join(ROOT, ".venv-launcher", "Scripts", "pythonw.exe")
PORT = 5173

NO_WINDOW = 0x08000000
WM_CLOSE = 0x0010

# Titles of the windows the launcher opens. Closing by title rather than by
# process id keeps this working when Chrome reuses processes.
WINDOW_TITLES = ("Daily Planner", "Today's Schedule")

user32 = ctypes.WinDLL("user32", use_last_error=True)

LOG = os.path.join(os.environ.get("TEMP", "."), "planner-restart.log")


def log(message):
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {message}\n")
    except Exception:
        pass


def run(args):
    """Run a helper with no console window of its own, ever."""
    try:
        return subprocess.run(
            args,
            creationflags=NO_WINDOW,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=25,
        )
    except Exception as exc:
        log(f"run {args[0]} failed: {exc}")
        return None


def find_windows(titles):
    hwnds = []

    def enum_proc(hwnd, _lparam):
        if user32.IsWindow(hwnd) and user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                if buff.value in titles:
                    hwnds.append(hwnd)
        return True

    proc = ctypes.WINFUNCTYPE(
        ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM
    )(enum_proc)
    user32.EnumWindows(proc, 0)
    return hwnds


def close_windows():
    hwnds = find_windows(WINDOW_TITLES)
    log(f"closing {len(hwnds)} window(s)")
    for hwnd in hwnds:
        try:
            user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        except Exception:
            pass
    # Give them a moment to go quietly before anything is killed outright.
    for _ in range(20):
        if not find_windows(WINDOW_TITLES):
            return
        time.sleep(0.15)
    log("some windows did not close in time; continuing anyway")


def pids_on_port(port):
    """Every process listening on the port, via netstat rather than a library,
    so this depends on nothing that could be missing."""
    out = run(["netstat", "-ano", "-p", "TCP"])
    if not out or not out.stdout:
        return []
    pids = set()
    needle = f":{port}"
    for line in out.stdout.decode("utf-8", "ignore").splitlines():
        parts = line.split()
        if len(parts) < 5 or "LISTENING" not in line:
            continue
        local = parts[1]
        if local.endswith(needle):
            pid = parts[-1]
            if pid.isdigit() and pid != "0":
                pids.add(pid)
    return sorted(pids)


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) != 0


def kill_helpers():
    """The widget and the hotkey listener, which the launcher will start again.

    Matched on their script path so this cannot hit an unrelated Python the user
    happens to be running.
    """
    out = run([
        "powershell", "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' or Name='python.exe'\" "
        "| Where-Object { $_.CommandLine -like '*widget-window.py*' "
        "-or $_.CommandLine -like '*focus-hotkey.py*' } "
        "| ForEach-Object { $_.ProcessId }",
    ])
    if not out or not out.stdout:
        return
    for line in out.stdout.decode("utf-8", "ignore").splitlines():
        pid = line.strip()
        if pid.isdigit() and int(pid) != os.getpid():
            log(f"killing helper {pid}")
            run(["taskkill", "/PID", pid, "/T", "/F"])


def own_process_chain():
    """This process and every ancestor of it, as strings.

    THE BUG THIS EXISTS FOR: the server spawns this helper, so this process is a
    CHILD of the server. Killing the server with `taskkill /T` -- kill the tree --
    therefore killed this script too, at the exact moment it was in the middle of
    doing the killing. The server went down, nothing brought it back, and the log
    simply stopped mid-line.

    So the server is killed WITHOUT /T, and anything in this chain is refused
    outright as a second line of defence.
    """
    chain = {str(os.getpid())}
    out = run([
        "powershell", "-NoProfile", "-NonInteractive", "-Command",
        "$id = $PID; "
        "while ($id -and $id -ne 0) { "
        "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -ErrorAction SilentlyContinue; "
        "  if (-not $p) { break }; "
        "  $p.ProcessId; $id = $p.ParentProcessId "
        "}",
    ])
    # $PID inside that PowerShell is PowerShell's own pid, whose parent is us,
    # so walking up from there covers this process and everything above it.
    if out and out.stdout:
        for line in out.stdout.decode("utf-8", "ignore").splitlines():
            pid = line.strip()
            if pid.isdigit():
                chain.add(pid)
    return chain


def stop_server():
    protected = own_process_chain()
    log(f"protected pids: {sorted(protected)}")

    # Two passes: the port holder usually dies on the first, but pnpm/npx wrap
    # the real node process and one of them can inherit the socket briefly.
    for attempt in range(4):
        pids = [p for p in pids_on_port(PORT) if p not in protected]
        if not pids:
            break
        log(f"attempt {attempt + 1}: killing {pids}")
        for pid in pids:
            # NO /T. See own_process_chain() above -- the tree includes us.
            run(["taskkill", "/PID", pid, "/F"])
        for _ in range(20):
            if port_free(PORT):
                break
            time.sleep(0.2)
        if port_free(PORT):
            break

    # Wait for the socket to actually be released. Starting the launcher while
    # the old socket lingers makes it think the server is up, so it starts
    # nothing -- and you are left with no planner at all.
    for _ in range(60):
        if port_free(PORT):
            log("port released")
            return True
        time.sleep(0.25)
    log("port still held after 15s; relaunching anyway")
    return False


def relaunch():
    python = PYTHONW if os.path.exists(PYTHONW) else None
    if python:
        args = [python, LAUNCHER]
    else:
        # No windowless interpreter: let Windows open the .pyw with whatever is
        # registered for it. Still no console, because .pyw maps to pythonw.
        args = None

    log(f"relaunching with {'pythonw' if python else 'shell association'}")
    try:
        if args:
            subprocess.Popen(
                args,
                cwd=ROOT,
                creationflags=NO_WINDOW | 0x00000200,   # new process group
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
        else:
            os.startfile(LAUNCHER)
    except Exception as exc:
        log(f"relaunch failed: {exc}")


def main():
    # Let the HTTP response reach the browser before the server dies under it,
    # so the button gets an answer instead of a network error.
    time.sleep(1.0)
    log("--- restart requested ---")

    close_windows()
    kill_helpers()
    freed = stop_server()
    log(f"port free before relaunch: {freed}")

    # The launcher holds a global mutex while it runs. The one that started the
    # old server has long since exited, but a restart pressed twice in quick
    # succession could overlap, so give it room.
    time.sleep(0.5)
    relaunch()

    # Verify rather than assume. A silent failure here is the worst outcome:
    # the planner is gone and nothing says why.
    for _ in range(120):
        if not port_free(PORT):
            log("--- server is back up ---")
            return
        time.sleep(0.5)
    log("!!! server did NOT come back within 60s -- run planner-launcher.pyw by hand")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # never leave a silent failure
        log(f"fatal: {exc}")
        sys.exit(1)
