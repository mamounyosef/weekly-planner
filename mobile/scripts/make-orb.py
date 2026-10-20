"""Render the assistant's orb images for the phone.

The phone has no SVG, so the orb the PC draws with CSS is rendered once into
PNGs from the SAME gradient stops (see src/components/agent/AgentOrb.tsx in
the web app). Re-run after changing the stops:

    python mobile/scripts/make-orb.py

Writes, into mobile/assets/:
  agent-orb.png        the orb itself: white core, periwinkle body, edge fading out
  agent-orb-glow.png   the soft halo that breathes behind it
  agent-orb-spark.png  the small highlight that drifts around inside it
"""

import math
import os

from PIL import Image

SIZE = 256
ACCENT = (124, 156, 255)  # #7c9cff, the Notes app's accent
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, '..', 'assets')


def lerp(a, b, t):
    return a + (b - a) * t


def radial(stops, size=SIZE, center=(0.5, 0.5), radius=0.5):
    """stops: [(offset 0..1, (r, g, b, a 0..1)), ...] along the radius."""
    img = Image.new('RGBA', (size, size))
    px = img.load()
    cx, cy = center[0] * size, center[1] * size
    rad = radius * size
    for y in range(size):
        for x in range(size):
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy) / rad
            if d >= stops[-1][0]:
                c = stops[-1][1]
            else:
                c = stops[0][1]
                for (o0, c0), (o1, c1) in zip(stops, stops[1:]):
                    if o0 <= d <= o1:
                        t = 0 if o1 == o0 else (d - o0) / (o1 - o0)
                        c = tuple(lerp(c0[i], c1[i], t) for i in range(4))
                        break
            px[x, y] = (round(c[0]), round(c[1]), round(c[2]), round(max(0, min(1, c[3])) * 255))
    return img


def main():
    os.makedirs(ASSETS, exist_ok=True)
    orb = radial([
        (0.0, (255, 255, 255, 1)),
        (0.25, (196, 210, 255, 1)),
        (0.70, (*ACCENT, 0.9)),
        (1.0, (*ACCENT, 0)),
    ])
    orb.save(os.path.join(ASSETS, 'agent-orb.png'))

    glow = radial([
        (0.0, (*ACCENT, 0.55)),
        (0.45, (*ACCENT, 0.18)),
        (0.70, (*ACCENT, 0)),
        (1.0, (*ACCENT, 0)),
    ])
    glow.save(os.path.join(ASSETS, 'agent-orb-glow.png'))

    spark = radial([
        (0.0, (255, 255, 255, 0.9)),
        (0.7, (255, 255, 255, 0)),
        (1.0, (255, 255, 255, 0)),
    ], size=128)
    spark.save(os.path.join(ASSETS, 'agent-orb-spark.png'))
    print('wrote agent-orb.png, agent-orb-glow.png, agent-orb-spark.png')


if __name__ == '__main__':
    main()
