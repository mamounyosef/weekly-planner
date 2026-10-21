"""Draw the two white light shapes the phone's voice orb is built from.

The orb (src/ui/VoiceOrb.tsx) tints and stacks these: a soft glow for the
halo, the core and the highlight, and a disc with a soft edge for the three
blobs that make its body. White with alpha, so `tintColor` gives any colour.

    python scripts/make-voice-orb.py
"""

import math
import os

from PIL import Image

N = 256
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")


def make(name, alpha_of):
    img = Image.new("RGBA", (N, N))
    px = img.load()
    c = (N - 1) / 2
    for y in range(N):
        for x in range(N):
            r = math.hypot(x - c, y - c) / (N / 2)
            a = max(0.0, min(1.0, alpha_of(r)))
            px[x, y] = (255, 255, 255, int(a * 255 + 0.5))
    img.save(os.path.join(OUT, name))
    print("wrote", name)


def soft(r):
    # A light that fades smoothly to nothing at the edge (no visible rim).
    if r >= 1:
        return 0.0
    return (1 - r * r) ** 2.2


def disc(r):
    # Solid inside, a soft anti-aliased edge over the outer 18%.
    if r <= 0.82:
        return 1.0
    if r >= 1:
        return 0.0
    t = (r - 0.82) / 0.18
    return 0.5 + 0.5 * math.cos(t * math.pi)


make("voice-soft.png", soft)
make("voice-disc.png", disc)
