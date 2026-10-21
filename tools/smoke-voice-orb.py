"""Smoke test of the floating orb's voice mode in a real window, without the app.

Shows a throwaway orb near the top-left corner for about eight seconds and
walks it through voice mode: grow, listening, hearing, thinking, speaking,
muted, then shrink back. Prints any error; the orb's saved position is kept
in a temp file, never database/orb.json.

    .venv-launcher\\Scripts\\python.exe tools\\smoke-voice-orb.py
"""

import json
import math
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import planner_orb  # noqa: E402

state = os.path.join(tempfile.gettempdir(), "planner-orb-smoke.json")
with open(state, "w", encoding="utf-8") as f:
    json.dump({"x": 120, "y": 120}, f)

events = []
orb = planner_orb.Orb(state, on_click=lambda: events.append("click"), on_double_click=lambda: None,
                      on_right_click=lambda: None, on_hover=lambda: None, on_drag_start=lambda: None,
                      on_moved=lambda: None, on_middle_click=lambda: events.append("middle"),
                      on_voice_tap=lambda: events.append("tap"))
orb.set_visible(True)
orb.start()
time.sleep(0.6)
print("normal size", orb.rect())

t0 = time.time()
for phase, secs in [("connecting", 0.8), ("listening", 1.2), ("hearing", 1.6), ("thinking", 1.4), ("speaking", 2.0), ("listening", 0.8)]:
    end = time.time() + secs
    while time.time() < end:
        k = time.time() - t0
        lvl = 0.5 + 0.45 * math.sin(k * 9) * math.sin(k * 2.3)
        orb.set_voice(True, phase, lvl if phase == "hearing" else 0.05, lvl if phase == "speaking" else 0, False)
        time.sleep(0.033)
    print(phase, "rect", orb.rect(), "voice_mode", orb.voice_mode)

orb.set_voice(False, "ended", 0, 0, False)
time.sleep(1.2)
print("after leaving: voice_mode", orb.voice_mode, "rect", orb.rect())
orb.close()
time.sleep(0.3)
print("OK" if not orb.voice_mode else "STILL IN VOICE MODE")
