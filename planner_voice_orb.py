"""The floating orb's voice look: what the dot turns into while you talk.

Middle-click the orb and it swells into a living ball of light that shows
the conversation without any text:

    listening   calm blue, breathing
    hearing     blue and cyan, its surface rippling with your voice
    thinking    indigo and violet, a comet circling it
    speaking    orange and amber, pulsing with the assistant's voice
    connecting  pale grey, shimmering, while the speech engine wakes up
    muted       grey and still
    error       red

The same design as the voice orb in the app (VoiceOrbCanvas.tsx), drawn here
with GDI+ into the orb's layered window: real per-pixel alpha against the
desktop, anti-aliased, and no browser. planner_orb.py owns the window; this
module only paints a frame into a 32-bit premultiplied buffer.
"""

import ctypes
import ctypes.wintypes as wt
import math
import random

gdiplus = ctypes.WinDLL("gdiplus")


class GdiplusStartupInput(ctypes.Structure):
    _fields_ = [("GdiplusVersion", ctypes.c_uint32), ("DebugEventCallback", ctypes.c_void_p),
                ("SuppressBackgroundThread", wt.BOOL), ("SuppressExternalCodecs", wt.BOOL)]


class PointF(ctypes.Structure):
    _fields_ = [("X", ctypes.c_float), ("Y", ctypes.c_float)]


_vp = ctypes.c_void_p
gdiplus.GdiplusStartup.argtypes = [ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(GdiplusStartupInput), _vp]
gdiplus.GdipCreateBitmapFromScan0.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, _vp, ctypes.POINTER(_vp)]
gdiplus.GdipGetImageGraphicsContext.argtypes = [_vp, ctypes.POINTER(_vp)]
gdiplus.GdipDeleteGraphics.argtypes = [_vp]
gdiplus.GdipDisposeImage.argtypes = [_vp]
gdiplus.GdipSetSmoothingMode.argtypes = [_vp, ctypes.c_int]
gdiplus.GdipSetCompositingQuality.argtypes = [_vp, ctypes.c_int]
gdiplus.GdipGraphicsClear.argtypes = [_vp, ctypes.c_uint32]
gdiplus.GdipCreatePath.argtypes = [ctypes.c_int, ctypes.POINTER(_vp)]
gdiplus.GdipDeletePath.argtypes = [_vp]
gdiplus.GdipAddPathEllipse.argtypes = [_vp, ctypes.c_float, ctypes.c_float, ctypes.c_float, ctypes.c_float]
gdiplus.GdipAddPathClosedCurve2.argtypes = [_vp, ctypes.POINTER(PointF), ctypes.c_int, ctypes.c_float]
gdiplus.GdipCreatePathGradientFromPath.argtypes = [_vp, ctypes.POINTER(_vp)]
gdiplus.GdipSetPathGradientCenterColor.argtypes = [_vp, ctypes.c_uint32]
gdiplus.GdipSetPathGradientCenterPoint.argtypes = [_vp, ctypes.POINTER(PointF)]
gdiplus.GdipSetPathGradientSurroundColorsWithCount.argtypes = [_vp, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_int)]
gdiplus.GdipSetPathGradientPresetBlend.argtypes = [_vp, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_float), ctypes.c_int]
gdiplus.GdipFillPath.argtypes = [_vp, _vp, _vp]
gdiplus.GdipDeleteBrush.argtypes = [_vp]
gdiplus.GdipCreateSolidFill.argtypes = [ctypes.c_uint32, ctypes.POINTER(_vp)]
gdiplus.GdipFillEllipse.argtypes = [_vp, _vp, ctypes.c_float, ctypes.c_float, ctypes.c_float, ctypes.c_float]
gdiplus.GdipCreatePen1.argtypes = [ctypes.c_uint32, ctypes.c_float, ctypes.c_int, ctypes.POINTER(_vp)]
gdiplus.GdipDrawEllipse.argtypes = [_vp, _vp, ctypes.c_float, ctypes.c_float, ctypes.c_float, ctypes.c_float]
gdiplus.GdipDeletePen.argtypes = [_vp]

PixelFormat32bppPARGB = 0x000E200B
SmoothingModeAntiAlias = 4
CompositingQualityHighQuality = 2
UnitPixel = 2

_token = ctypes.c_size_t(0)


def _startup():
    if not _token.value:
        si = GdiplusStartupInput(1, None, False, False)
        gdiplus.GdiplusStartup(ctypes.byref(_token), ctypes.byref(si), None)


def _hex(h):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


PALETTES = {
    "listening": dict(core=_hex("#eaf4ff"), mid=_hex("#60a5fa"), edge=_hex("#1d4ed8"), glow=_hex("#3b82f6"), accent=_hex("#22d3ee")),
    "hearing": dict(core=_hex("#f0fbff"), mid=_hex("#38bdf8"), edge=_hex("#2563eb"), glow=_hex("#0ea5e9"), accent=_hex("#67e8f9")),
    "thinking": dict(core=_hex("#f5f3ff"), mid=_hex("#a78bfa"), edge=_hex("#4f46e5"), glow=_hex("#7c3aed"), accent=_hex("#e879f9")),
    "speaking": dict(core=_hex("#fff7ed"), mid=_hex("#fb923c"), edge=_hex("#ea580c"), glow=_hex("#f97316"), accent=_hex("#fbbf24")),
    "connecting": dict(core=_hex("#f1f5f9"), mid=_hex("#94a3b8"), edge=_hex("#475569"), glow=_hex("#64748b"), accent=_hex("#cbd5e1")),
    "muted": dict(core=_hex("#e5e7eb"), mid=_hex("#6b7280"), edge=_hex("#374151"), glow=_hex("#4b5563"), accent=_hex("#9ca3af")),
    "error": dict(core=_hex("#fef2f2"), mid=_hex("#f87171"), edge=_hex("#b91c1c"), glow=_hex("#ef4444"), accent=_hex("#fca5a5")),
}

BLOBS = [
    dict(waves=[(2, 0.55, 0.0), (3, -0.8, 1.3), (5, 1.15, 2.1)], scale=1.0, drift=0.12, alpha=0.95),
    dict(waves=[(3, 0.7, 0.7), (4, -1.0, 2.4), (7, 1.4, 0.4)], scale=0.93, drift=-0.18, alpha=0.65),
    dict(waves=[(2, -0.45, 1.9), (5, 0.9, 0.2), (6, -1.3, 1.1)], scale=0.86, drift=0.22, alpha=0.55),
]


def palette_for(phase, muted):
    if phase == "error":
        return PALETTES["error"]
    if muted and phase not in ("speaking", "thinking"):
        return PALETTES["muted"]
    if phase in ("loading", "connecting", "ended", "off"):
        return PALETTES["connecting"]
    return PALETTES.get(phase, PALETTES["listening"])


def _lerp(a, b, t):
    return a + (b - a) * t


def _mix(a, b, t):
    return (_lerp(a[0], b[0], t), _lerp(a[1], b[1], t), _lerp(a[2], b[2], t))


def _argb(c, a):
    a = int(max(0.0, min(1.0, a)) * 255 + 0.5)
    return (a << 24) | (int(c[0]) << 16) | (int(c[1]) << 8) | int(c[2])


class VoiceOrbRenderer:
    """Keeps the animation state between frames; `frame()` paints one."""

    def __init__(self):
        _startup()
        self.pal = dict(PALETTES["connecting"])
        self.energy = 0.0
        self.slow = 0.0
        self.spin = 0.0
        self.think = 0.0
        self.t = 0.0
        self.ripples = []   # [age, strength]
        self.sparks = []    # [angle, radius, speed, size, life, age]
        self.last_ripple = 0.0
        self.grow = 0.0     # 0 = still the small dot, 1 = fully the voice orb

    def frame(self, bits, size, dt, phase, mic, out, muted, appear):
        """Paint into `bits` (size x size, premultiplied BGRA). `appear` is
        the target of the grow animation (1 while in voice mode, 0 leaving)."""
        dt = min(0.05, max(0.0, dt))
        self.t += dt
        t = self.t
        self.grow = _lerp(self.grow, appear, 1 - math.exp(-dt * (9 if appear > self.grow else 12)))

        target = out if phase == "speaking" else mic if phase in ("hearing", "listening") else 0.0
        k = 1 - math.exp(-dt * (28 if target > self.energy else 5))
        self.energy = _lerp(self.energy, target, k)
        self.slow = _lerp(self.slow, self.energy, 1 - math.exp(-dt * 2.5))
        busy = 1.0 if phase in ("thinking", "loading", "connecting") else 0.0
        self.think = _lerp(self.think, busy, 1 - math.exp(-dt * 3))
        self.spin += dt * (0.25 + self.think * 2.2 + self.energy * 1.5)
        tp = palette_for(phase, muted)
        pk = 1 - math.exp(-dt * 4)
        for key in self.pal:
            self.pal[key] = _mix(self.pal[key], tp[key], pk)
        pal = self.pal
        e = self.energy

        for r in self.ripples:
            r[0] += dt
        self.ripples = [r for r in self.ripples if r[0] < 1.5]
        if phase in ("hearing", "speaking") and self.energy > 0.32 and self.energy > self.slow * 1.25 and t - self.last_ripple > 0.26:
            self.ripples.append([0.0, min(1.0, self.energy)])
            self.last_ripple = t

        bmp = ctypes.c_void_p()
        g = ctypes.c_void_p()
        gdiplus.GdipCreateBitmapFromScan0(size, size, size * 4, PixelFormat32bppPARGB, bits, ctypes.byref(bmp))
        gdiplus.GdipGetImageGraphicsContext(bmp, ctypes.byref(g))
        try:
            gdiplus.GdipSetSmoothingMode(g, SmoothingModeAntiAlias)
            gdiplus.GdipSetCompositingQuality(g, CompositingQualityHighQuality)
            gdiplus.GdipGraphicsClear(g, 0)
            self._paint(g, size, dt, phase, pal, e, t)
        finally:
            gdiplus.GdipDeleteGraphics(g)
            gdiplus.GdipDisposeImage(bmp)

    # ── drawing helpers ──

    def _radial(self, g, cx, cy, r, stops):
        """A circle filled from the centre outwards. stops: [(pos 0..1, argb)]."""
        if r <= 0.5:
            return
        path = ctypes.c_void_p()
        brush = ctypes.c_void_p()
        gdiplus.GdipCreatePath(0, ctypes.byref(path))
        gdiplus.GdipAddPathEllipse(path, cx - r, cy - r, 2 * r, 2 * r)
        gdiplus.GdipCreatePathGradientFromPath(path, ctypes.byref(brush))
        # GDI+ preset blends run from the EDGE (0) to the centre (1).
        n = len(stops)
        cols = (ctypes.c_uint32 * n)(*[c for _p, c in reversed(stops)])
        pos = (ctypes.c_float * n)(*[1.0 - p for p, _c in reversed(stops)])
        gdiplus.GdipSetPathGradientPresetBlend(brush, cols, pos, n)
        gdiplus.GdipFillPath(g, brush, path)
        gdiplus.GdipDeleteBrush(brush)
        gdiplus.GdipDeletePath(path)

    def _dot(self, g, x, y, r, argb):
        brush = ctypes.c_void_p()
        gdiplus.GdipCreateSolidFill(argb, ctypes.byref(brush))
        gdiplus.GdipFillEllipse(g, brush, x - r, y - r, 2 * r, 2 * r)
        gdiplus.GdipDeleteBrush(brush)

    def _ring(self, g, x, y, r, w, argb):
        pen = ctypes.c_void_p()
        gdiplus.GdipCreatePen1(argb, w, UnitPixel, ctypes.byref(pen))
        gdiplus.GdipDrawEllipse(g, pen, x - r, y - r, 2 * r, 2 * r)
        gdiplus.GdipDeletePen(pen)

    def _paint(self, g, size, dt, phase, pal, e, t):
        c = size / 2.0
        grow = self.grow
        breathe = math.sin(t * (1.4 if phase == "listening" else 2.2)) * 0.5 + 0.5
        # Sized so that everything, at its loudest, fades out well inside the
        # square window: anything reaching the edge was cut off there and
        # showed the window as a faint box against the desktop.
        full_r = size * 0.19 * (1 + e * 0.16 + breathe * 0.025 + self.think * 0.02)
        # Growing out of the small dot (its core is about 7 px across).
        R = _lerp(size * 0.11, full_r, grow)
        edge = size * 0.47

        halo = min(edge, R * (1.75 + e * 0.55 + breathe * 0.08))
        self._radial(g, c, c, halo, [
            (0.0, _argb(pal["glow"], 0.0)),
            (0.25, _argb(pal["glow"], 0.42 + e * 0.25)),
            (0.6, _argb(pal["glow"], 0.14 + e * 0.1)),
            (1.0, _argb(pal["glow"], 0.0)),
        ])

        for age, strength in self.ripples:
            a = age / 1.5
            self._ring(g, c, c, min(edge * 0.92, R * (1.05 + a * 0.85)), max(0.6, size * 0.012 * (1 - a)),
                       _argb(_mix(pal["accent"], pal["mid"], 0.4), (1 - a) * 0.5 * strength * grow))

        # The body: three warped blobs, each a smooth closed curve.
        N = 28
        wob = 0.035 + e * 0.22 + self.think * 0.03
        pts = (PointF * N)()
        for bi, b in enumerate(BLOBS):
            rot = self.spin * b["drift"]
            ox = math.cos(t * 0.7 + bi * 2.1) * R * 0.05 * (1 + e)
            oy = math.sin(t * 0.9 + bi * 1.3) * R * 0.05 * (1 + e)
            for i in range(N):
                th = i / N * 2 * math.pi
                d = 0.0
                for h, sp, p0 in b["waves"]:
                    d += math.sin(h * (th + rot) + t * sp * (1 + e * 2.5) + p0) / h
                rr = R * b["scale"] * (1 + wob * d * 0.6)
                pts[i].X = c + ox + math.cos(th) * rr
                pts[i].Y = c + oy + math.sin(th) * rr
            col = pal["mid"] if bi == 0 else _mix(pal["mid"], pal["accent"], 0.55) if bi == 1 else _mix(pal["edge"], pal["accent"], 0.3)
            path = ctypes.c_void_p()
            brush = ctypes.c_void_p()
            gdiplus.GdipCreatePath(0, ctypes.byref(path))
            gdiplus.GdipAddPathClosedCurve2(path, pts, N, 0.5)
            gdiplus.GdipCreatePathGradientFromPath(path, ctypes.byref(brush))
            centre = PointF(c + ox - R * 0.2, c + oy - R * 0.25)
            gdiplus.GdipSetPathGradientCenterPoint(brush, ctypes.byref(centre))
            al = b["alpha"]
            stops = [(0.0, _argb(_mix(pal["core"], col, 0.25), 0.62 * al)), (0.55, _argb(col, 0.55 * al)), (1.0, _argb(pal["edge"], 0.3 * al))]
            n = len(stops)
            cols = (ctypes.c_uint32 * n)(*[s[1] for s in reversed(stops)])
            pos = (ctypes.c_float * n)(*[1.0 - s[0] for s in reversed(stops)])
            gdiplus.GdipSetPathGradientPresetBlend(brush, cols, pos, n)
            gdiplus.GdipFillPath(g, brush, path)
            gdiplus.GdipDeleteBrush(brush)
            gdiplus.GdipDeletePath(path)

        core_r = R * (0.62 + e * 0.12)
        self._radial(g, c, c, core_r, [(0.0, _argb(pal["core"], 0.95)), (0.35, _argb(pal["core"], 0.55 + e * 0.3)), (1.0, _argb(pal["core"], 0.0))])
        hx = c + math.cos(t * 0.6) * R * 0.28 - R * 0.12
        hy = c + math.sin(t * 0.45) * R * 0.22 - R * 0.2
        self._radial(g, hx, hy, R * 0.42, [(0.0, _argb((255, 255, 255), 0.5)), (1.0, _argb((255, 255, 255), 0.0))])

        if self.think > 0.02:
            orbit = R * 1.32
            head = self.spin * 1.6
            for i in range(18):
                a = head - i * 0.1
                fade = (1 - i / 18) * self.think * grow
                self._dot(g, c + math.cos(a) * orbit, c + math.sin(a) * orbit, max(0.5, size * 0.018 * (1 - i / 22)),
                          _argb(pal["core"] if i < 3 else pal["accent"], fade * 0.85))

        if phase == "speaking" and self.energy > 0.15 and random.random() < self.energy * 0.9:
            self.sparks.append([random.random() * 2 * math.pi, R * 0.95, R * (0.5 + random.random() * 0.9),
                                size * (0.008 + random.random() * 0.012), 0.9 + random.random() * 0.6, 0.0])
        alive = []
        for s in self.sparks:
            s[5] += dt
            if s[5] < s[4]:
                alive.append(s)
        self.sparks = alive[-60:]
        for ang, rad, speed, sz, life, age in self.sparks:
            f = age / life
            rr = rad + speed * age
            # Sparks fade out as they near the window's edge, never at it.
            fade = max(0.0, min(1.0, (edge - sz - rr) / (size * 0.1)))
            if fade <= 0:
                continue
            a = ang + age * 0.6
            self._dot(g, c + math.cos(a) * rr, c + math.sin(a) * rr, sz * (1 - f * 0.6),
                      _argb(_mix(pal["accent"], pal["core"], 0.3), (1 - f) * 0.85 * grow * fade))
