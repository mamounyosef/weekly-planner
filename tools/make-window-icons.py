"""Draw the two taskbar icons: one per planner window.

Both windows live in one process, so without their own icons the taskbar shows
two identical buttons. The main planner is a wide window (blue), the side
widget a tall narrow one (teal), on the same dark tile so they still read as
one app.

Re-run after changing the design:
    .venv-launcher\\Scripts\\python.exe tools\\make-window-icons.py
Writes icon-main.ico and icon-widget.ico to the repo root.
"""

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024  # drawn large, then scaled down for clean edges at every size
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

TILE = (36, 38, 44, 255)
BLUE = (122, 176, 240, 255)
TEAL = (88, 204, 160, 255)


def tile():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((24, 24, S - 24, S - 24), radius=230, fill=TILE)
    return img, d


def main_icon():
    img, d = tile()
    w = 76  # stroke
    box = (170, 250, S - 170, S - 250)
    d.rounded_rectangle(box, radius=70, outline=BLUE, width=w)
    d.rounded_rectangle((box[0], box[1], box[2], box[1] + 150), radius=70, fill=BLUE)
    # two column rules: a calendar week
    for x in (box[0] + (box[2] - box[0]) // 3, box[0] + 2 * (box[2] - box[0]) // 3):
        d.rectangle((x - 22, box[1] + 140, x + 22, box[3] - 40), fill=BLUE)
    return img


def widget_icon():
    img, d = tile()
    w = 76
    box = (345, 150, S - 345, S - 150)
    d.rounded_rectangle(box, radius=70, outline=TEAL, width=w)
    d.rounded_rectangle((box[0], box[1], box[2], box[1] + 160), radius=70, fill=TEAL)
    # three schedule lines
    for i, y in enumerate((box[1] + 260, box[1] + 400, box[1] + 540)):
        right = box[2] - 95 - (50 if i == 2 else 0)
        d.rounded_rectangle((box[0] + 95, y, right, y + 52), radius=26, fill=TEAL)
    return img


def save(img, name):
    frames = [img.resize((n, n), Image.LANCZOS) for n in SIZES]
    path = os.path.join(ROOT, name)
    frames[-1].save(path, format="ICO", sizes=[(n, n) for n in SIZES],
                    append_images=frames[:-1])
    print("wrote", path)


if __name__ == "__main__":
    save(main_icon(), "icon-main.ico")
    save(widget_icon(), "icon-widget.ico")
