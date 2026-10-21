"""The floating orb: a tiny always-on-top dot that hides the side widget away.

Drawn natively on purpose. A third WebView2 window would cost its own renderer
process (tens of MB) and could not do real per-pixel transparency, so the ring
edges would be jagged against the desktop. This is one layered Win32 window
painted from a small BGRA buffer with UpdateLayeredWindow: true anti-aliased
alpha, no browser, and frames are cached so an idle orb costs nothing.

What it shows: a ring that fills with today's focus time, where a full circle
is the average day of the last 30. Past the average the core turns orange and
the extra time laps the ring again in gold. While a session runs the halo
breathes.

What it does is not decided here: every gesture is reported through the
callbacks given to `Orb`, and widget-window.py decides what that means.
"""

import ctypes
import ctypes.wintypes as wt
import json
import math
import os
import threading
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32")
kernel32 = ctypes.WinDLL("kernel32")

LRESULT = ctypes.c_int64
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM)


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint), ("style", ctypes.c_uint), ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int), ("hInstance", wt.HINSTANCE),
        ("hIcon", wt.HICON), ("hCursor", wt.HANDLE), ("hbrBackground", wt.HBRUSH),
        ("lpszMenuName", wt.LPCWSTR), ("lpszClassName", wt.LPCWSTR), ("hIconSm", wt.HICON),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG), ("biPlanes", wt.WORD),
        ("biBitCount", wt.WORD), ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
        ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD),
        ("biClrImportant", wt.DWORD),
    ]


class BLENDFUNCTION(ctypes.Structure):
    _fields_ = [("BlendOp", ctypes.c_ubyte), ("BlendFlags", ctypes.c_ubyte),
                ("SourceConstantAlpha", ctypes.c_ubyte), ("AlphaFormat", ctypes.c_ubyte)]


class TRACKMOUSEEVENT(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("dwFlags", wt.DWORD), ("hwndTrack", wt.HWND), ("dwHoverTime", wt.DWORD)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]


user32.DefWindowProcW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
user32.DefWindowProcW.restype = LRESULT
user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
user32.RegisterClassExW.restype = wt.ATOM
user32.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, wt.HWND, wt.HMENU, wt.HINSTANCE, wt.LPVOID]
user32.CreateWindowExW.restype = wt.HWND
user32.LoadCursorW.argtypes = [wt.HINSTANCE, ctypes.c_void_p]
user32.LoadCursorW.restype = wt.HANDLE
user32.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), wt.HWND, ctypes.c_uint, ctypes.c_uint]
user32.TranslateMessage.argtypes = [ctypes.POINTER(wt.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wt.MSG)]
user32.PostMessageW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
user32.UpdateLayeredWindow.argtypes = [wt.HWND, wt.HDC, ctypes.POINTER(wt.POINT), ctypes.POINTER(wt.SIZE), wt.HDC,
                                       ctypes.POINTER(wt.POINT), wt.COLORREF, ctypes.POINTER(BLENDFUNCTION), wt.DWORD]
user32.GetDC.argtypes = [wt.HWND]
user32.GetDC.restype = wt.HDC
user32.ReleaseDC.argtypes = [wt.HWND, wt.HDC]
user32.SetTimer.argtypes = [wt.HWND, ctypes.c_size_t, ctypes.c_uint, ctypes.c_void_p]
user32.KillTimer.argtypes = [wt.HWND, ctypes.c_size_t]
user32.SetCapture.argtypes = [wt.HWND]
user32.TrackMouseEvent.argtypes = [ctypes.POINTER(TRACKMOUSEEVENT)]
user32.GetCursorPos.argtypes = [ctypes.POINTER(wt.POINT)]
user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
user32.MonitorFromPoint.argtypes = [wt.POINT, wt.DWORD]
user32.MonitorFromPoint.restype = wt.HMONITOR
user32.GetMonitorInfoW.argtypes = [wt.HMONITOR, ctypes.POINTER(MONITORINFO)]
user32.DestroyWindow.argtypes = [wt.HWND]
user32.GetDpiForSystem.restype = ctypes.c_uint
gdi32.CreateCompatibleDC.argtypes = [wt.HDC]
gdi32.CreateCompatibleDC.restype = wt.HDC
gdi32.CreateDIBSection.argtypes = [wt.HDC, ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p), wt.HANDLE, wt.DWORD]
gdi32.CreateDIBSection.restype = wt.HBITMAP
gdi32.SelectObject.argtypes = [wt.HDC, wt.HGDIOBJ]
gdi32.SelectObject.restype = wt.HGDIOBJ
gdi32.DeleteObject.argtypes = [wt.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wt.HDC]
kernel32.GetModuleHandleW.argtypes = [wt.LPCWSTR]
kernel32.GetModuleHandleW.restype = wt.HMODULE

WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_DISPLAYCHANGE = 0x007E
WM_MOUSEACTIVATE = 0x0021
WM_TIMER = 0x0113
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONUP = 0x0205
WM_MBUTTONDOWN = 0x0207
WM_MBUTTONUP = 0x0208
WM_MOUSELEAVE = 0x02A3
WM_CAPTURECHANGED = 0x0215
WM_SETCURSOR = 0x0020
WM_APP_REDRAW = 0x8001
WM_APP_SHOW = 0x8002
WM_APP_VOICE = 0x8003
MA_NOACTIVATE = 3
CS_DBLCLKS = 0x0008
WS_POPUP = 0x80000000
WS_EX_LAYERED = 0x00080000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_TOPMOST = 0x00000008
WS_EX_NOACTIVATE = 0x08000000
HWND_TOPMOST = wt.HWND(-1)
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_NOMOVE = 0x0002
SW_HIDE = 0
SW_SHOWNOACTIVATE = 4
ULW_ALPHA = 0x02
AC_SRC_ALPHA = 0x01
TME_LEAVE = 0x02
IDC_HAND = 32649
MONITOR_DEFAULTTONULL = 0
MONITOR_DEFAULTTONEAREST = 2

TIMER_HOVER = 1
TIMER_BREATHE = 2
TIMER_TOPMOST = 3
TIMER_VOICE = 4

# Geometry in logical pixels (scaled by the system DPI).
SIZE = 34
HALO_R, HALO_W = 15.4, 1.4
RING_R, RING_W = 11.4, 3.6
BACK_R = 13.5
CORE_R = 7.4
ALERT_X, ALERT_Y, ALERT_R = 27.3, 6.7, 3.7

HOVER_MS = 200           # how long to rest on the orb before the widget peeks
DRAG_THRESHOLD = 4        # logical px of movement before a press becomes a drag
SNAP_DISTANCE = 30        # logical px from a screen edge that snaps flush to it
EDGE_GAP = 3              # logical px left between a snapped orb and the edge
BREATHE_FRAMES = 20
BREATHE_MS = 2600
VOICE_SIZE = 104          # logical px of the window while in voice mode
VOICE_FRAME_MS = 16
VOICE_STALE_S = 3.0       # no news from the page this long: show "connecting"
VOICE_DEAD_S = 30.0       # ...and this long: the page is gone, leave voice mode

BLUE = (90, 169, 255)
GOLD = (255, 194, 71)
CORE_BLUE = (59, 130, 246)
CORE_DONE = (255, 157, 46)
TRACK = (255, 255, 255)
BACK = (16, 22, 32)
ALERT = (239, 68, 68)


def _cov(d):
    """Anti-aliased coverage for a signed distance (negative = inside)."""
    v = 0.5 - d
    return 0.0 if v <= 0 else 1.0 if v >= 1 else v


def render(size, scale, frac, running_phase, alert, hover):
    """One frame as premultiplied BGRA bytes, `size` x `size` physical pixels.

    frac: today / average (0 = nothing yet, 1 = average reached, 2 = double).
    running_phase: None when no session runs, else 0..1 through a breath.
    hover: None, or 0..1 progress towards the peek.
    """
    c = size / 2.0
    s = scale
    halo_r, halo_w = HALO_R * s, HALO_W * s
    ring_r, ring_w = RING_R * s, RING_W * s
    back_r, core_r = BACK_R * s, CORE_R * s
    ax, ay, ar = ALERT_X * s, ALERT_Y * s, ALERT_R * s
    done = frac >= 1.0
    base = min(max(frac, 0.0), 1.0)
    over = min(max(frac - 1.0, 0.0), 1.0)
    two_pi = 2 * math.pi

    if running_phase is None:
        halo_a = 0.42
    else:
        halo_a = 0.30 + 0.55 * (0.5 - 0.5 * math.cos(two_pi * running_phase))
    if hover is not None:
        halo_a = max(halo_a, 0.6)
    halo_col = GOLD if done else BLUE
    core_col = CORE_DONE if done else CORE_BLUE
    base_col = BLUE

    def arc_d(px, py, rho, ang, r, w, sweep):
        """Distance to a round-capped arc starting at 12 o'clock, clockwise."""
        if sweep <= 0:
            return 1e9
        if sweep >= 1:
            return abs(rho - r) - w / 2
        if ang <= sweep * two_pi:
            return abs(rho - r) - w / 2
        e = sweep * two_pi
        ex, ey = c + r * math.sin(e), c - r * math.cos(e)
        sx, sy = c, c - r
        return min(math.hypot(px - sx, py - sy), math.hypot(px - ex, py - ey)) - w / 2

    out = bytearray(size * size * 4)
    outer = halo_r + halo_w  # nothing is drawn beyond this, except the alert dot
    i = 0
    for y in range(size):
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            dx, dy = px - c, py - c
            rho = math.hypot(dx, dy)
            layers = []
            if rho <= outer:
                ang = math.atan2(dx, -dy)
                if ang < 0:
                    ang += two_pi
                layers.append((halo_col, _cov(abs(rho - halo_r) - halo_w / 2) * halo_a))
                if hover:
                    # white on a dark outline: readable on any wallpaper
                    layers.append((BACK, _cov(arc_d(px, py, rho, ang, halo_r, halo_w * 1.25 + 1.6 * s, hover)) * 0.55))
                    layers.append((TRACK, _cov(arc_d(px, py, rho, ang, halo_r, halo_w * 1.25, hover))))
                if rho <= back_r + 1:
                    layers.append((BACK, _cov(rho - back_r) * 0.62))
                    if abs(rho - ring_r) <= ring_w / 2 + 1:
                        layers.append((TRACK, _cov(abs(rho - ring_r) - ring_w / 2) * 0.16))
                        layers.append((base_col, _cov(arc_d(px, py, rho, ang, ring_r, ring_w, base))))
                        if over > 0:
                            layers.append((GOLD, _cov(arc_d(px, py, rho, ang, ring_r, ring_w, over))))
                    if rho <= core_r + 1:
                        layers.append((core_col, _cov(rho - core_r)))
            if alert:
                da = math.hypot(px - ax, py - ay)
                if da <= ar + 1.1 * s + 1:
                    layers.append((BACK, _cov(da - ar - 1.1 * s)))
                    layers.append((ALERT, _cov(da - ar)))
            # Back to front, straight "over"; r/g/b come out alpha-weighted,
            # which is exactly the premultiplied form UpdateLayeredWindow wants.
            r = g = b = a = 0.0
            for col, al in layers:
                if al <= 0:
                    continue
                k = 1 - al
                r = col[0] * al + r * k
                g = col[1] * al + g * k
                b = col[2] * al + b * k
                a = al + a * k
            if a > 0:
                out[i] = int(min(255, b + 0.5))
                out[i + 1] = int(min(255, g + 0.5))
                out[i + 2] = int(min(255, r + 0.5))
                out[i + 3] = int(min(255, a * 255 + 0.5))
            i += 4
    return bytes(out)


class Orb:
    """The orb window. Construct, then `start()`; everything else is thread-safe."""

    def __init__(self, state_path, on_click, on_double_click, on_right_click, on_hover,
                 on_drag_start, on_moved, on_middle_click=None, on_voice_tap=None):
        self.state_path = state_path
        self.cb_click = on_click
        self.cb_double = on_double_click
        self.cb_right = on_right_click
        self.cb_hover = on_hover
        self.cb_drag_start = on_drag_start
        self.cb_moved = on_moved
        self.cb_middle = on_middle_click
        self.cb_voice_tap = on_voice_tap

        self.hwnd = None
        self.scale = 1.0
        self.size = SIZE
        self.cur = SIZE           # the window's size right now (bigger in voice mode)

        # Voice mode (planner_voice_orb.py draws it). `voice_want` is what the
        # page asked for; `voice_mode` is what the window is doing, which
        # includes the shrink animation on the way out.
        self.voice_want = False
        self.voice_mode = False
        self.voice_phase = "connecting"
        self.voice_mic = 0.0
        self.voice_out = 0.0
        self.voice_muted = False
        self.voice_seen = 0.0
        self._voice_renderer = None
        self._voice_last = 0.0
        self._voice_center = None
        self._wndproc = WNDPROC(self._proc)
        self._ready = threading.Event()

        self.frac = 0.0
        self.running = False
        self.alert = False
        self._visible = False

        self._hover_started = None
        self._tracking = False
        self._press = None        # (cursor x, y, window x, y) while the left button is down
        self._dragging = False
        self._suppress_up = False
        self._breathe_i = 0
        self._cache = {}
        self._dib = None

    # ── public, any thread ─────────────────────────────────────────────────

    def start(self):
        threading.Thread(target=self._thread, name="planner-orb", daemon=True).start()
        self._ready.wait(5)

    def set_state(self, frac, running, alert):
        frac = round(max(0.0, min(2.0, float(frac))), 3)
        changed = (frac, bool(running), bool(alert)) != (self.frac, self.running, self.alert)
        self.frac, self.running, self.alert = frac, bool(running), bool(alert)
        if changed and self.hwnd:
            user32.PostMessageW(self.hwnd, WM_APP_REDRAW, 0, 0)

    def set_voice(self, on, phase="listening", mic=0.0, out=0.0, muted=False):
        """The page's voice session, about 30 times a second while it runs."""
        self.voice_phase = str(phase or "listening")
        try:
            self.voice_mic = max(0.0, min(1.0, float(mic)))
            self.voice_out = max(0.0, min(1.0, float(out)))
        except (TypeError, ValueError):
            pass
        self.voice_muted = bool(muted)
        self.voice_seen = time.monotonic()
        on = bool(on)
        if on != self.voice_want:
            self.voice_want = on
            if self.hwnd:
                user32.PostMessageW(self.hwnd, WM_APP_VOICE, 1 if on else 0, 0)

    def set_visible(self, on):
        self._visible = bool(on)
        if self.hwnd:
            user32.PostMessageW(self.hwnd, WM_APP_SHOW, 1 if on else 0, 0)

    def rect(self):
        rc = wt.RECT()
        if self.hwnd and user32.GetWindowRect(self.hwnd, ctypes.byref(rc)):
            return rc.left, rc.top, rc.right, rc.bottom
        return None

    def close(self):
        if self.hwnd:
            user32.PostMessageW(self.hwnd, WM_CLOSE, 0, 0)

    # ── persistence ────────────────────────────────────────────────────────

    def _load_pos(self):
        try:
            with open(self.state_path, "r", encoding="utf-8") as f:
                d = json.load(f)
            return int(d["x"]), int(d["y"])
        except Exception:
            return None

    def _save_pos(self, x, y):
        try:
            try:
                with open(self.state_path, "r", encoding="utf-8") as f:
                    d = json.load(f)
            except Exception:
                d = {}
            d["x"], d["y"] = int(x), int(y)
            tmp = self.state_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(d, f)
            os.replace(tmp, self.state_path)
        except Exception as e:
            print("Failed to save orb position:", e)

    def _work_area(self, x, y, fallback=True):
        mon = user32.MonitorFromPoint(wt.POINT(int(x), int(y)),
                                      MONITOR_DEFAULTTONEAREST if fallback else MONITOR_DEFAULTTONULL)
        if not mon:
            return None
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if not user32.GetMonitorInfoW(mon, ctypes.byref(info)):
            return None
        w = info.rcWork
        return w.left, w.top, w.right, w.bottom

    def _placed(self, x, y, snap, n=None):
        """Clamp onto the nearest screen, snapping flush to an edge when close."""
        n = n or self.size
        wa = self._work_area(x + n // 2, y + n // 2)
        if not wa:
            return x, y
        left, top, right, bottom = wa
        gap = round(EDGE_GAP * self.scale)
        x = min(max(x, left + gap), right - n - gap)
        y = min(max(y, top + gap), bottom - n - gap)
        if snap:
            reach = SNAP_DISTANCE * self.scale
            if x - left < reach:
                x = left + gap
            elif right - (x + n) < reach:
                x = right - n - gap
            if y - top < reach:
                y = top + gap
            elif bottom - (y + n) < reach:
                y = bottom - n - gap
        return int(x), int(y)

    def _initial_pos(self):
        saved = self._load_pos()
        if saved and self._work_area(saved[0] + self.size // 2, saved[1] + self.size // 2, fallback=False):
            return self._placed(saved[0], saved[1], snap=False)
        wa = self._work_area(0, 0)
        left, top, right, bottom = wa or (0, 0, 1920, 1080)
        return self._placed(right - self.size, top + int((bottom - top) * 0.42), snap=True)

    # ── drawing ────────────────────────────────────────────────────────────

    def _frame(self):
        phase_i = self._breathe_i if self.running else None
        # No hover countdown arc: with a 0.2s delay it only read as a loading
        # spinner. The orb looks the same until the widget appears.
        hover = None
        key = (self.frac, phase_i, self.alert, hover)
        buf = self._cache.get(key)
        if buf is None:
            if len(self._cache) > 160:
                self._cache.clear()
            phase = None if phase_i is None else phase_i / BREATHE_FRAMES
            buf = render(self.size, self.scale, self.frac, phase, self.alert, hover)
            self._cache[key] = buf
        return buf

    def _ensure_dib(self):
        if self._dib and self._dib[3] == self.cur:
            return self._dib
        if self._dib:
            gdi32.DeleteObject(self._dib[1])
            gdi32.DeleteDC(self._dib[0])
            self._dib = None
        screen = user32.GetDC(None)
        mem = gdi32.CreateCompatibleDC(screen)
        user32.ReleaseDC(None, screen)
        bmi = BITMAPINFOHEADER()
        bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.biWidth = self.cur
        bmi.biHeight = -self.cur  # top-down
        bmi.biPlanes = 1
        bmi.biBitCount = 32
        bits = ctypes.c_void_p()
        bmp = gdi32.CreateDIBSection(mem, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
        gdi32.SelectObject(mem, bmp)
        self._dib = (mem, bmp, bits, self.cur)
        return self._dib

    def _paint(self):
        if not self.hwnd:
            return
        mem, _bmp, bits, n = self._ensure_dib()
        if self.voice_mode:
            self._paint_voice(bits, n)
        else:
            buf = self._frame()
            ctypes.memmove(bits, buf, len(buf))
        screen = user32.GetDC(None)
        size = wt.SIZE(n, n)
        src = wt.POINT(0, 0)
        blend = BLENDFUNCTION(0, 0, 255, AC_SRC_ALPHA)
        user32.UpdateLayeredWindow(self.hwnd, screen, None, ctypes.byref(size), mem,
                                   ctypes.byref(src), 0, ctypes.byref(blend), ULW_ALPHA)
        user32.ReleaseDC(None, screen)

    # ── voice mode ─────────────────────────────────────────────────────────

    def _paint_voice(self, bits, n):
        now = time.monotonic()
        dt = now - self._voice_last if self._voice_last else 1 / 60
        self._voice_last = now
        stale = now - self.voice_seen
        phase = self.voice_phase if stale < VOICE_STALE_S else "connecting"
        appear = 1.0 if self.voice_want else 0.0
        ctypes.memset(bits, 0, n * n * 4)
        try:
            self._voice_renderer.frame(bits, n, dt, phase, self.voice_mic, self.voice_out, self.voice_muted, appear)
        except Exception as e:
            print("Voice orb frame failed:", e)

    def _voice_enter(self):
        if self.voice_mode or not self.hwnd:
            return
        if not hasattr(self, "_voice_renderer_cls"):
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "planner_voice_orb", os.path.join(os.path.dirname(os.path.abspath(__file__)), "planner_voice_orb.py"))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            self._voice_renderer_cls = mod.VoiceOrbRenderer
        self._voice_renderer = self._voice_renderer_cls()
        self._cancel_hover()
        rc = wt.RECT()
        user32.GetWindowRect(self.hwnd, ctypes.byref(rc))
        cx, cy = (rc.left + rc.right) // 2, (rc.top + rc.bottom) // 2
        self._voice_center = (cx, cy)
        vs = int(round(VOICE_SIZE * self.scale))
        self.voice_mode = True
        self.cur = vs
        x, y = self._placed(cx - vs // 2, cy - vs // 2, snap=False, n=vs)
        self._voice_last = 0.0
        self._voice_moved = False
        user32.SetWindowPos(self.hwnd, HWND_TOPMOST, x, y, vs, vs, SWP_NOACTIVATE)
        self._paint()
        user32.KillTimer(self.hwnd, TIMER_BREATHE)
        user32.SetTimer(self.hwnd, TIMER_VOICE, VOICE_FRAME_MS, None)

    def _voice_leave_done(self):
        """The shrink has finished: back to the plain dot, where it was."""
        user32.KillTimer(self.hwnd, TIMER_VOICE)
        self.voice_mode = False
        rc = wt.RECT()
        user32.GetWindowRect(self.hwnd, ctypes.byref(rc))
        cx, cy = (rc.left + rc.right) // 2, (rc.top + rc.bottom) // 2
        if self._voice_center and not getattr(self, "_voice_moved", False):
            cx, cy = self._voice_center
        self._voice_moved = False
        self.cur = self.size
        x, y = self._placed(cx - self.size // 2, cy - self.size // 2, snap=True)
        self._paint()
        user32.SetWindowPos(self.hwnd, None, x, y, self.size, self.size, SWP_NOZORDER | SWP_NOACTIVATE)
        self._voice_renderer = None
        self._sync_breathing()

    def _voice_tick(self):
        if not self.voice_mode:
            user32.KillTimer(self.hwnd, TIMER_VOICE)
            return
        if self.voice_want and time.monotonic() - self.voice_seen > VOICE_DEAD_S:
            # The page that ran the conversation has gone quiet for good.
            self.voice_want = False
        self._paint()
        if not self.voice_want and self._voice_renderer.grow < 0.06:
            self._voice_leave_done()

    def _sync_breathing(self):
        if self.voice_mode:
            user32.KillTimer(self.hwnd, TIMER_BREATHE)
            return
        if self.running and self._visible:
            user32.SetTimer(self.hwnd, TIMER_BREATHE, BREATHE_MS // BREATHE_FRAMES, None)
        else:
            user32.KillTimer(self.hwnd, TIMER_BREATHE)
            self._breathe_i = 0

    # ── window ─────────────────────────────────────────────────────────────

    def _thread(self):
        try:
            try:
                self.scale = max(1.0, user32.GetDpiForSystem() / 96.0)
            except Exception:
                self.scale = 1.0
            self.size = int(round(SIZE * self.scale))
            hinst = kernel32.GetModuleHandleW(None)
            wc = WNDCLASSEXW()
            wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
            wc.style = CS_DBLCLKS
            wc.lpfnWndProc = self._wndproc
            wc.hInstance = hinst
            wc.hCursor = user32.LoadCursorW(None, ctypes.c_void_p(IDC_HAND))
            wc.lpszClassName = "PlannerOrbWindow"
            user32.RegisterClassExW(ctypes.byref(wc))
            x, y = self._initial_pos()
            self.hwnd = user32.CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
                "PlannerOrbWindow", "Planner Orb", WS_POPUP,
                x, y, self.size, self.size, None, None, hinst, None)
        except Exception as e:
            print("Failed to create the orb:", e)
            self._ready.set()
            return
        self._paint()
        if self._visible:
            user32.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE)
        # Full-screen apps and other top-most windows can push us down; re-assert
        # now and then without ever taking focus.
        user32.SetTimer(self.hwnd, TIMER_TOPMOST, 2000, None)
        self._ready.set()
        msg = wt.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    def _cursor(self):
        pt = wt.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        return pt.x, pt.y

    def _fire(self, cb, *args):
        """Callbacks run off the orb thread so the orb never waits on a webview."""
        if cb:
            threading.Thread(target=cb, args=args, daemon=True).start()

    def _cancel_hover(self):
        if self._hover_started is not None:
            self._hover_started = None
            user32.KillTimer(self.hwnd, TIMER_HOVER)
            self._paint()

    def _proc(self, hwnd, msg, wparam, lparam):
        try:
            if msg == WM_MOUSEACTIVATE:
                return MA_NOACTIVATE

            if msg == WM_MOUSEMOVE:
                if not self._tracking:
                    tme = TRACKMOUSEEVENT(ctypes.sizeof(TRACKMOUSEEVENT), TME_LEAVE, hwnd, 0)
                    user32.TrackMouseEvent(ctypes.byref(tme))
                    self._tracking = True
                if self._press:
                    cx, cy = self._cursor()
                    px, py, wx, wy = self._press
                    if not self._dragging and max(abs(cx - px), abs(cy - py)) >= DRAG_THRESHOLD * self.scale:
                        self._dragging = True
                        self._cancel_hover()
                        self._fire(self.cb_drag_start)
                    if self._dragging:
                        user32.SetWindowPos(hwnd, None, wx + cx - px, wy + cy - py, 0, 0,
                                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
                elif self._hover_started is None and not self.voice_mode:
                    self._hover_started = time.monotonic()
                    user32.SetTimer(hwnd, TIMER_HOVER, 33, None)
                return 0

            if msg == WM_MOUSELEAVE:
                self._tracking = False
                if not self._press:
                    self._cancel_hover()
                return 0

            if msg == WM_LBUTTONDOWN or msg == WM_LBUTTONDBLCLK:
                rc = wt.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rc))
                cx, cy = self._cursor()
                self._press = (cx, cy, rc.left, rc.top)
                self._dragging = False
                user32.SetCapture(hwnd)
                if msg == WM_LBUTTONDBLCLK:
                    self._suppress_up = True
                    self._cancel_hover()
                    self._fire(self.cb_double)
                return 0

            if msg == WM_LBUTTONUP:
                user32.ReleaseCapture()
                was_drag = self._dragging
                self._press = None
                self._dragging = False
                if was_drag and self.voice_mode:
                    # The big voice orb was moved: remember where the small dot
                    # will be once it shrinks back, not the big window's corner.
                    rc = wt.RECT()
                    user32.GetWindowRect(hwnd, ctypes.byref(rc))
                    x, y = self._placed(rc.left, rc.top, snap=False, n=self.cur)
                    user32.SetWindowPos(hwnd, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
                    self._voice_moved = True
                    cx, cy = x + self.cur // 2, y + self.cur // 2
                    sx, sy = self._placed(cx - self.size // 2, cy - self.size // 2, snap=True)
                    threading.Thread(target=self._save_pos, args=(sx, sy), daemon=True).start()
                elif was_drag:
                    rc = wt.RECT()
                    user32.GetWindowRect(hwnd, ctypes.byref(rc))
                    x, y = self._placed(rc.left, rc.top, snap=True)
                    user32.SetWindowPos(hwnd, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
                    threading.Thread(target=self._save_pos, args=(x, y), daemon=True).start()
                    self._fire(self.cb_moved)
                elif self._suppress_up:
                    self._suppress_up = False
                elif self.voice_mode:
                    self._fire(self.cb_voice_tap)
                else:
                    self._cancel_hover()
                    self._fire(self.cb_click)
                return 0

            if msg == WM_CAPTURECHANGED:
                if self._press and self._dragging:
                    # Lost the mouse mid-drag (Alt+Tab, a UAC prompt): keep the spot.
                    rc = wt.RECT()
                    user32.GetWindowRect(hwnd, ctypes.byref(rc))
                    threading.Thread(target=self._save_pos, args=(rc.left, rc.top), daemon=True).start()
                self._press = None
                self._dragging = False
                return 0

            if msg == WM_RBUTTONUP:
                self._cancel_hover()
                self._fire(self.cb_right)
                return 0

            if msg == WM_MBUTTONDOWN:
                return 0

            if msg == WM_MBUTTONUP:
                # Middle click (the wheel): start or end voice mode.
                self._cancel_hover()
                self._fire(self.cb_middle)
                return 0

            if msg == WM_TIMER:
                if wparam == TIMER_HOVER:
                    if self._hover_started is None:
                        user32.KillTimer(hwnd, TIMER_HOVER)
                    elif (time.monotonic() - self._hover_started) * 1000 >= HOVER_MS:
                        self._hover_started = None
                        user32.KillTimer(hwnd, TIMER_HOVER)
                        self._paint()
                        self._fire(self.cb_hover)
                    else:
                        self._paint()
                elif wparam == TIMER_BREATHE:
                    self._breathe_i = (self._breathe_i + 1) % BREATHE_FRAMES
                    self._paint()
                elif wparam == TIMER_VOICE:
                    self._voice_tick()
                elif wparam == TIMER_TOPMOST and self._visible:
                    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
                return 0

            if msg == WM_APP_REDRAW:
                self._sync_breathing()
                if not self.voice_mode:
                    self._paint()
                return 0

            if msg == WM_APP_VOICE:
                if wparam and self.voice_want:
                    self._voice_enter()
                # Leaving is the shrink animation, run by the voice timer.
                return 0

            if msg == WM_APP_SHOW:
                if wparam:
                    rc = wt.RECT()
                    user32.GetWindowRect(hwnd, ctypes.byref(rc))
                    x, y = self._placed(rc.left, rc.top, snap=False)
                    user32.SetWindowPos(hwnd, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)
                    user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
                else:
                    self._cancel_hover()
                    if self.voice_mode:
                        self.voice_want = False
                        self._voice_leave_done()
                    user32.ShowWindow(hwnd, SW_HIDE)
                self._sync_breathing()
                return 0

            if msg == WM_DISPLAYCHANGE:
                rc = wt.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rc))
                if not self._work_area(rc.left + self.size // 2, rc.top + self.size // 2, fallback=False):
                    x, y = self._placed(rc.left, rc.top, snap=True)
                    user32.SetWindowPos(hwnd, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)

            if msg == WM_CLOSE:
                user32.DestroyWindow(hwnd)
                return 0

            if msg == WM_DESTROY:
                self.hwnd = None
                user32.PostQuitMessage(0)
                return 0
        except Exception as e:
            print("Orb window error:", e)
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)
