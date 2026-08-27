"""Handles the `plannernotify:` protocol behind the Windows toast buttons.

A native toast cannot call back into a web app. What it can do is open a URL,
so every button on a planner toast opens `plannernotify:<action>?...`, Windows
launches this file, and this file turns it back into one API call against the
local dev server.

Run with pythonw.exe: it must never flash a console. The whole round trip is
Snooze-pressed to store-written in well under a second, and because the store is
the shared source of truth, the phone's copy of that notification disappears at
the same time.

Usage:
    pythonw notify-action.pyw --register        # idempotent, run at startup
    pythonw notify-action.pyw "plannernotify:snooze?key=...&minutes=10"
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(os.path.dirname(__file__)))
SERVER = "http://127.0.0.1:5173"
PROTOCOL = "plannernotify"
NO_WINDOW = 0x08000000

VALID_ACTIONS = {"open", "read", "snooze", "done", "ack"}


def register() -> None:
    """Point HKCU at this script for `plannernotify:` links.

    HKCU rather than HKLM deliberately: it needs no elevation, so the planner
    can repair its own registration silently every time it starts instead of
    depending on an install step that may never have been run.
    """
    import winreg

    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.exists(pythonw):
        pythonw = sys.executable
    target = f'"{pythonw}" "{os.path.abspath(__file__)}" "%1"'

    base = rf"Software\Classes\{PROTOCOL}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as key:
        winreg.SetValueEx(key, None, 0, winreg.REG_SZ, "URL:Daily Planner Notification")
        winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")

    icon = os.path.join(ROOT, "app-icon.ico")
    if os.path.exists(icon):
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\DefaultIcon") as key:
            winreg.SetValueEx(key, None, 0, winreg.REG_SZ, icon)

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as key:
        winreg.SetValueEx(key, None, 0, winreg.REG_SZ, target)


def post(path: str, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        SERVER + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=8).read()
    except urllib.error.URLError:
        # The server being down is the one case where nothing can be done, and
        # there is nowhere to report it to. Failing silently is correct here:
        # the notification simply stays unread, which is the safe direction.
        pass


def open_planner(key: str) -> None:
    """Bring the planner up on the item the toast was about."""
    url = f"{SERVER}/?notifications=1&open={urllib.parse.quote(key)}"
    launcher = os.path.join(ROOT, "planner-launcher.pyw")

    # If the app is already running this simply focuses it; if it is not, the
    # launcher starts the whole stack. Either way one click reaches the item.
    if os.path.exists(launcher):
        pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        try:
            subprocess.Popen(
                [pythonw if os.path.exists(pythonw) else sys.executable, launcher, "--focus", url],
                creationflags=NO_WINDOW,
                close_fds=True,
            )
            return
        except OSError:
            pass
    os.startfile(url)  # noqa: S606 - a local http URL, opened in the default browser


def main(argv: list) -> int:
    if "--register" in argv:
        register()
        return 0
    if not argv:
        return 0

    parsed = urllib.parse.urlparse(argv[0])
    if parsed.scheme != PROTOCOL:
        return 0

    action = (parsed.netloc or parsed.path).strip("/").strip()
    if action not in VALID_ACTIONS:
        return 0

    q = urllib.parse.parse_qs(parsed.query)
    key = (q.get("key") or [""])[0]
    user = (q.get("user") or [""])[0]
    token = (q.get("token") or [""])[0]
    minutes = (q.get("minutes") or ["10"])[0]

    if action == "open":
        # Opening also clears it: reaching the item is dealing with it.
        if key:
            post("/api/notifications/agent-action", {
                "action": "read", "keys": [key], "user": user, "token": token, "deviceId": "windows-toast",
            })
        open_planner(key)
        return 0

    if not key:
        return 0

    payload = {
        "action": action,
        "keys": [key],
        "user": user,
        "token": token,
        "deviceId": "windows-toast",
    }
    if action == "snooze":
        try:
            payload["minutes"] = int(minutes)
        except ValueError:
            payload["minutes"] = 10

    post("/api/notifications/agent-action", payload)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
