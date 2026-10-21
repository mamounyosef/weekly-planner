"""Render the floating orb's voice look (planner_voice_orb.py) to a PNG sheet,
one tile per state, on a dark and a light desktop, without starting the app.

    .venv-launcher\\Scripts\\python.exe tools\\preview-voice-orb.py [out.png]
"""

import ctypes
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from PIL import Image  # noqa: E402

import planner_voice_orb as vo  # noqa: E402

SIZE = 160
STATES = [("connecting", 0, 0, False), ("listening", 0.05, 0, False), ("hearing", 0.7, 0, False),
          ("thinking", 0, 0, False), ("speaking", 0, 0.8, False), ("listening", 0, 0, True), ("error", 0, 0, False)]


def tile(phase, mic, out, muted):
    r = vo.VoiceOrbRenderer()
    buf = (ctypes.c_ubyte * (SIZE * SIZE * 4))()
    # Run the animation for a second and a half so colours settle and ripples appear.
    for i in range(90):
        wobble = 0.6 + 0.4 * math.sin(i * 0.4)
        r.frame(buf, SIZE, 1 / 60, phase, mic * wobble, out * wobble, muted, 1.0)
    # Anything visible on the window's edge shows the window as a box.
    edge = max(max(buf[(y * SIZE + x) * 4 + 3] for x in range(SIZE)) for y in (0, 1, SIZE - 2, SIZE - 1))
    edge = max(edge, max(max(buf[(y * SIZE + x) * 4 + 3] for y in range(SIZE)) for x in (0, 1, SIZE - 2, SIZE - 1)))
    print("%-10s alpha on the window edge: %d%s" % (phase, edge, "" if edge <= 2 else "  <- BOX VISIBLE"))
    img = Image.frombuffer("RGBA", (SIZE, SIZE), bytes(buf), "raw", "BGRA", 0, 1)
    # Premultiplied -> straight alpha for compositing in PIL.
    px = img.load()
    for y in range(SIZE):
        for x in range(SIZE):
            b, g, rr, a = px[x, y][2], px[x, y][1], px[x, y][0], px[x, y][3]
            if a:
                px[x, y] = (min(255, rr * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), a)
    return img


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "database", "voice-orb-preview.png")
    sheet = Image.new("RGBA", (SIZE * len(STATES), SIZE * 2), (0, 0, 0, 255))
    for i, (phase, mic, o, muted) in enumerate(STATES):
        t = tile(phase, mic, o, muted)
        for row, bg in enumerate([(24, 26, 32, 255), (236, 239, 244, 255)]):
            base = Image.new("RGBA", (SIZE, SIZE), bg)
            base.alpha_composite(t)
            sheet.paste(base, (i * SIZE, row * SIZE))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sheet.save(out)
    print("wrote", out)
    # What one frame costs at the real window size (104 logical px at 125%).
    import time
    r = vo.VoiceOrbRenderer()
    n = 130
    buf = (ctypes.c_ubyte * (n * n * 4))()
    t = time.perf_counter()
    for i in range(240):
        r.frame(buf, n, 1 / 60, "speaking", 0, 0.5 + 0.4 * math.sin(i * 0.3), False, 1.0)
    ms = (time.perf_counter() - t) / 240 * 1000
    print("frame: %.2f ms (%.0f%% of one core at 60 fps)" % (ms, ms * 60 / 10))


if __name__ == "__main__":
    main()
