"""Watch the ESP32 desk link from the PC side.

Polls /api/hardware/live and pings the board, logging every gap where the
board stopped reaching the server. Run:  python tools/desk-link-monitor.py [seconds]
"""
import json
import subprocess
import sys
import threading
import time
import urllib.request

LIVE = "http://127.0.0.1:5173/api/hardware/live"
BOARD = "planner-desk.local"
DURATION = float(sys.argv[1]) if len(sys.argv) > 1 else 180

pings = []


def pinger(ip):
    end = time.time() + DURATION
    while time.time() < end:
        t = time.time()
        r = subprocess.run(["ping", "-n", "1", "-w", "1000", ip], capture_output=True, text=True)
        ms = None
        for tok in r.stdout.split():
            if tok.startswith("time=") or tok.startswith("time<"):
                ms = float(tok[5:].rstrip("ms"))
        pings.append((t, ms))
        time.sleep(max(0, 0.5 - (time.time() - t)))


def resolve():
    r = subprocess.run(["powershell", "-NoProfile", "-Command",
                        f"(Resolve-DnsName {BOARD} -Type A).IPAddress"], capture_output=True, text=True)
    return r.stdout.strip().splitlines()[0]


def main():
    ip = resolve()
    print(f"board {ip}, watching {DURATION:.0f}s")
    th = threading.Thread(target=pinger, args=(ip,), daemon=True)
    th.start()
    end = time.time() + DURATION
    worst = 0
    ages = []
    while time.time() < end:
        try:
            d = json.load(urllib.request.urlopen(LIVE, timeout=3))
            age = d.get("ageMs") or 0
            ages.append(age)
            if age > 1500:
                print(f"{time.strftime('%H:%M:%S')} board silent {age}ms diag={d.get('diag')}")
            worst = max(worst, age)
        except Exception as e:
            print(f"{time.strftime('%H:%M:%S')} server error {e}")
        time.sleep(0.25)
    th.join(timeout=3)
    lost = sum(1 for _, m in pings if m is None)
    rtts = sorted(m for _, m in pings if m is not None)
    print(f"live ageMs: worst {worst}, >1s {sum(a > 1000 for a in ages)}/{len(ages)}")
    if rtts:
        print(f"ping: {len(pings)} sent, {lost} lost, median {rtts[len(rtts)//2]}ms, "
              f"p95 {rtts[int(len(rtts)*0.95)]}ms, max {rtts[-1]}ms")
    else:
        print(f"ping: {len(pings)} sent, all lost")


if __name__ == "__main__":
    main()
