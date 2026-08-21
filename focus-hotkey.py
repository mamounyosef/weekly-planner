# System-wide focus-timer hotkey.
#
# A browser window only sees keystrokes while it has focus, so the in-app
# shortcut stops working the moment you switch to another program. This tiny
# background process registers the hotkey with Windows itself (RegisterHotKey),
# so it fires no matter what you are doing, then asks the planner's dev server
# to start / pause / resume the timer. It never *stops* a session.
#
# The binding is whatever "Start / pause timer" is set to in the app's Settings:
# this process re-reads it from the dev server every few seconds and re-registers
# itself when you change it. No window, no console — started hidden by
# start-planner.bat via pythonw.

import ctypes
import ctypes.wintypes
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

# 127.0.0.1, not "localhost": the name resolves to ::1 first on Windows and the
# failed IPv6 attempt adds a fixed ~200ms to every request.
BASE_URL = "http://127.0.0.1:5173"
TOGGLE_URL = BASE_URL + "/api/focus-timer/toggle"
SETTINGS_URL = BASE_URL + "/api/settings"
ROOT = Path(__file__).resolve().parent
LOCAL_USERS_PATH = ROOT / "database" / "users.json"

# Used until the dev server tells us what the user configured. It must match
# FOCUS_TIMER_TOGGLE_DEFAULT in src/lib/shortcuts.ts exactly (case is immaterial
# to RegisterHotKey).
FALLBACK_COMBO = "win+shift+f1"
LEGACY_FALLBACK_COMBO = "alt+shift+f1"
SHORTCUT_DEFAULTS_VERSION = 2

# Modifier bits for RegisterHotKey.
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
MOD_NOREPEAT = 0x4000  # holding the keys down fires once, not continuously

WM_HOTKEY = 0x0312
WM_TIMER = 0x0113
VK_F1 = 0x70

HOTKEY_ID = 1
TIMER_ID = 1
SETTINGS_POLL_MS = 4000

_MOD_NAMES = {
    "alt": MOD_ALT,
    "ctrl": MOD_CONTROL,
    "control": MOD_CONTROL,
    "meta": MOD_CONTROL,  # the app treats Ctrl and Cmd as one modifier
    "shift": MOD_SHIFT,
    "win": MOD_WIN,
}

# Keys the app can produce that map to a virtual-key code.
_NAMED_KEYS = {
    "space": 0x20,
    "enter": 0x0D,
    "escape": 0x1B,
    "esc": 0x1B,
    "delete": 0x2E,
    "del": 0x2E,
    "backspace": 0x08,
    "tab": 0x09,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "arrowleft": 0x25,
    "arrowup": 0x26,
    "arrowright": 0x27,
    "arrowdown": 0x28,
}

user32 = ctypes.WinDLL("user32", use_last_error=True)


def already_running():
    """True if another copy of this helper is alive.

    Launching the app twice used to leave several of these running. Only one can
    ever own the hotkey, so the extras sat in a loop re-attempting the binding
    every few seconds — and if the owner exited, more than one could end up
    reacting to the same press.
    """
    ERROR_ALREADY_EXISTS = 183
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # Version the mutex name with the binding migration. A previously-installed
    # helper can remain alive while an update is being applied; it must not stop
    # this version from registering the corrected Win+Shift+F1 binding.
    kernel32.CreateMutexW(None, False, "Global\\PlannerFocusHotkeyV2")
    return ctypes.get_last_error() == ERROR_ALREADY_EXISTS


def parse_combo(combo):
    """'Win+Shift+F1' -> (modifier bits, virtual key code), or None if unusable."""
    mods = 0
    vk = None
    for part in str(combo).lower().split("+"):
        part = part.strip()
        if not part:
            continue
        if part in _MOD_NAMES:
            mods |= _MOD_NAMES[part]
        elif part in _NAMED_KEYS:
            vk = _NAMED_KEYS[part]
        elif part.startswith("f") and part[1:].isdigit() and 1 <= int(part[1:]) <= 24:
            vk = VK_F1 + (int(part[1:]) - 1)
        elif len(part) == 1:
            vk = ord(part.upper())
    if vk is None:
        return None
    return mods | MOD_NOREPEAT, vk


def get_json(url):
    try:
        with urllib.request.urlopen(url, timeout=4) as res:
            # utf-8-sig: the settings file can carry a BOM, which plain utf-8
            # decoding leaves in place and json.loads then rejects.
            return json.loads(res.read().decode("utf-8-sig") or "{}")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def read_json_file(path):
    """Read a local JSON file without turning a missing/corrupt file into a crash."""
    try:
        return json.loads(path.read_text(encoding="utf-8-sig") or "{}")
    except (OSError, ValueError):
        return None


def combo_from_settings(data):
    """Return the configured timer combo from one settings object, if present."""
    if isinstance(data, dict):
        shortcuts = data.get("shortcuts")
        if isinstance(shortcuts, dict):
            combo = shortcuts.get("toggleTimer")
            if isinstance(combo, str) and combo.strip():
                # Settings written before shortcut-default version 2 used the
                # old Alt binding. Upgrade only that historical default; an
                # explicit Alt+Shift+F1 selection in a version-2 file remains
                # a valid custom binding.
                version = data.get("shortcutDefaultsVersion", 1)
                if (
                    (not isinstance(version, (int, float)) or version < SHORTCUT_DEFAULTS_VERSION)
                    and combo.strip().lower() == LEGACY_FALLBACK_COMBO
                ):
                    return FALLBACK_COMBO
                return combo.strip()
    return None


def configured_combo():
    """The 'Start / pause timer' binding, including before web auth is ready."""
    combo = combo_from_settings(get_json(SETTINGS_URL))
    if combo:
        return combo

    # The helper starts before Chrome has necessarily restored its session, and
    # an authenticated /api/settings response is not guaranteed at that point.
    # Its original loopback fallback already targeted the first local profile;
    # read that same profile directly so global shortcuts remain configurable on
    # a cold launch too. No credential is read or stored here.
    access = read_json_file(LOCAL_USERS_PATH)
    users = access.get("users") if isinstance(access, dict) else None
    first = users[0] if isinstance(users, list) and users else None
    username = first.get("username") if isinstance(first, dict) else None
    if isinstance(username, str) and username and all(c.isalnum() or c in "_-" for c in username):
        return combo_from_settings(read_json_file(ROOT / "database" / "users" / username / "settings.json"))
    return None


def toggle_timer():
    """Start, or pause a running session. Never ends the session."""
    req = urllib.request.Request(TOGGLE_URL, data=b"", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=4):
            pass
    except (urllib.error.URLError, OSError):
        pass  # dev server down — ignore and keep listening


def bind(combo):
    """(Re)register the hotkey. Returns the combo actually bound, or None."""
    parsed = parse_combo(combo)
    if not parsed:
        return None
    user32.UnregisterHotKey(None, HOTKEY_ID)
    mods, vk = parsed
    if not user32.RegisterHotKey(None, HOTKEY_ID, mods, vk):
        return None  # almost always: another program already owns this combo
    return combo


def main():
    if already_running():
        return 0
    current = None
    wanted = configured_combo() or (sys.argv[1] if len(sys.argv) > 1 else FALLBACK_COMBO)
    current = bind(wanted) or bind(FALLBACK_COMBO)

    user32.SetTimer(None, TIMER_ID, SETTINGS_POLL_MS, None)
    try:
        msg = ctypes.wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            if msg.message == WM_HOTKEY:
                toggle_timer()
            elif msg.message == WM_TIMER:
                # Pick up a rebind made in the app's Settings.
                latest = configured_combo()
                if latest and latest != current:
                    bound = bind(latest)
                    if bound:
                        current = bound
    finally:
        user32.KillTimer(None, TIMER_ID)
        user32.UnregisterHotKey(None, HOTKEY_ID)
    return 0


if __name__ == "__main__":
    sys.exit(main())
