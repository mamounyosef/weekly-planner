"""Keeps the planner public link alive.

The public URL (https://<self>.ts.net) is a Tailscale Funnel pointing at the dev
server on 127.0.0.1:5173. Three separate things can take it down, and each one
looks identical from outside ("This site can't be reached"):

  1. tailscaled is running but the backend is *Stopped* (a Disconnect click, or
     the GUI restarting without logging back in). The DNS name stops resolving
     at all, which is the NXDOMAIN the browser reports.
  2. The funnel/serve config is gone, so the name resolves but nothing proxies.
  3. The dev server is down, so the funnel proxies to a closed port.

This checks all three every few minutes and repairs whichever is broken. It is
deliberately idempotent: when everything is healthy it runs four cheap probes
and writes nothing but a state stamp.

Run with pythonw.exe (no console). Scheduled by tools/install-link-watchdog.ps1.
Create database/watchdog-off to pause it (used when deliberately stopping the
dev server), delete that file to resume.
"""

import json
import os
import socket
import ssl
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "database")
LOG = os.path.join(DB, "link-watchdog.log")
STATE = os.path.join(DB, "link-watchdog-state.json")
PAUSE = os.path.join(DB, "watchdog-off")

LOCAL_URL = "http://127.0.0.1:5173"
PORT = "5173"
NO_WINDOW = 0x08000000

TAILSCALE = next(
    (p for p in (
        r"C:\Program Files\Tailscale\tailscale.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale.exe",
    ) if os.path.exists(p)),
    None,
)

# The dev server is only declared dead after this many consecutive failed
# probes. A single miss is usually a rebuild: vite restarting briefly refuses
# connections, and relaunching the whole planner over that would be worse than
# the symptom.
SERVER_STRIKES = 2


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S") + "  " + msg
    try:
        os.makedirs(DB, exist_ok=True)
        prev = []
        if os.path.exists(LOG):
            with open(LOG, "r", encoding="utf-8", errors="replace") as f:
                prev = f.read().splitlines()[-800:]
        with open(LOG, "w", encoding="utf-8") as f:
            f.write("\n".join(prev + [line]) + "\n")
    except Exception:
        pass


def load_state():
    try:
        with open(STATE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    try:
        os.makedirs(DB, exist_ok=True)
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except Exception:
        pass


def run(args, timeout=60):
    """Run a command with no console window. Returns (rc, output)."""
    try:
        p = subprocess.run(
            args,
            cwd=ROOT,
            creationflags=NO_WINDOW,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
        )
        return p.returncode, p.stdout.decode("utf-8", "replace").strip()
    except Exception as e:
        return -1, str(e)


# --- 1. the tailscale backend -------------------------------------------------

def tailscale_state():
    """(BackendState, DNSName) from the daemon, or (None, None) if unreachable."""
    rc, out = run([TAILSCALE, "status", "--json"], timeout=30)
    if rc != 0:
        return None, None
    try:
        data = json.loads(out)
    except Exception:
        return None, None
    host = (data.get("Self") or {}).get("DNSName") or ""
    return data.get("BackendState"), host.rstrip(".")


def ensure_service():
    """tailscaled itself. Starting a stopped service needs admin, so a failure
    here is logged rather than retried: it is the one case a human must fix."""
    rc, out = run(["sc", "query", "Tailscale"], timeout=30)
    if rc == 0 and "RUNNING" in out:
        return True
    log("service Tailscale not running, starting it")
    rc, out = run(["net", "start", "Tailscale"], timeout=90)
    if rc != 0:
        log("  could not start the service (needs admin): " + out.replace("\n", " ")[:200])
        return False
    return True


def ensure_backend():
    state, host = tailscale_state()
    if state == "Running":
        return host
    log("backend state is %r, running `tailscale up`" % state)
    rc, out = run([TAILSCALE, "up"], timeout=120)
    if rc != 0:
        log("  up failed: " + out.replace("\n", " ")[:200])
    state, host = tailscale_state()
    log("  backend now %r" % state)
    return host if state == "Running" else None


# --- 2. the funnel ------------------------------------------------------------

def funnel_ok():
    """True when the funnel is on AND proxying to our port. `serve status` alone
    is not enough: it prints the config even while the funnel is switched off."""
    rc, out = run([TAILSCALE, "serve", "status"], timeout=30)
    if rc != 0:
        return False
    return "Funnel on" in out and PORT in out


def ensure_funnel():
    if funnel_ok():
        return True
    log("funnel not serving %s, re-asserting it" % PORT)
    rc, out = run([TAILSCALE, "funnel", "--bg", PORT], timeout=60)
    if rc != 0:
        log("  funnel command failed: " + out.replace("\n", " ")[:200])
    ok = funnel_ok()
    log("  funnel ok now: %s" % ok)
    return ok


# --- 3. the dev server --------------------------------------------------------

def server_up():
    try:
        with urllib.request.urlopen(LOCAL_URL, timeout=5):
            return True
    except Exception:
        return False


def start_planner():
    """Hand off to the normal launcher. It is mutex-guarded and only starts what
    is missing, so this cannot end up with two servers or a second window."""
    launcher = os.path.join(ROOT, "planner-launcher.pyw")
    pythonw = os.path.join(ROOT, ".venv-launcher", "Scripts", "pythonw.exe")
    if not os.path.exists(pythonw):
        pythonw = sys.executable.replace("python.exe", "pythonw.exe")
    try:
        subprocess.Popen(
            [pythonw, launcher],
            cwd=ROOT,
            creationflags=NO_WINDOW,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except Exception as e:
        log("  could not start the launcher: %s" % e)
        return False


# --- 4. the actual public path ------------------------------------------------

def public_ip(host):
    """Resolve through a public resolver, not this machine. Locally the name
    resolves to the 100.x tailnet address, so a fetch from here can succeed
    while the outside world still gets nothing."""
    rc, out = run(["nslookup", host, "8.8.8.8"], timeout=30)
    if rc != 0:
        return None
    ips = []
    seen_name = False
    for line in out.splitlines():
        line = line.strip()
        if line.lower().startswith("name:"):
            seen_name = True
            continue
        if not seen_name:
            continue
        if line.lower().startswith("address"):
            line = line.split(":", 1)[1]
        for part in line.replace("\t", " ").split():
            # IPv4 only: the checker has to reach it, and this box may have no
            # working IPv6 route even when the funnel is perfectly healthy.
            if part.count(".") == 3 and all(c.isdigit() or c == "." for c in part):
                ips.append(part)
    return ips[0] if ips else None


def public_ok(host):
    """Fetch / through the public ingress with the right SNI."""
    ip = public_ip(host)
    if not ip:
        return False, "no public DNS record"
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((ip, 443), timeout=15) as raw:
            with ctx.wrap_socket(raw, server_hostname=host) as s:
                s.sendall(
                    ("GET / HTTP/1.1\r\nHost: %s\r\nUser-Agent: planner-watchdog\r\n"
                     "Connection: close\r\n\r\n" % host).encode()
                )
                head = s.recv(64).decode("utf-8", "replace")
        code = head.split(" ")[1] if head.startswith("HTTP/") and " " in head else "?"
        # Any answer means the whole chain is intact. 401 counts as healthy too:
        # that is the public password gate doing its job.
        return code.isdigit() and int(code) < 500, "HTTP " + code
    except Exception as e:
        return False, type(e).__name__ + ": " + str(e)[:120]


def main():
    if os.path.exists(PAUSE):
        return
    if not TAILSCALE:
        log("tailscale.exe not found, nothing to watch")
        return

    state = load_state()

    ensure_service()
    host = ensure_backend()

    # The dev server is repaired before the public probe, so one pass fixes a
    # dead server rather than reporting it and waiting for the next run.
    if server_up():
        state["server_misses"] = 0
    else:
        state["server_misses"] = state.get("server_misses", 0) + 1
        log("dev server not answering (%d in a row)" % state["server_misses"])
        if state["server_misses"] >= SERVER_STRIKES:
            log("  starting the planner")
            if start_planner():
                for _ in range(60):
                    time.sleep(1)
                    if server_up():
                        break
                log("  dev server back: %s" % server_up())
                state["server_misses"] = 0

    ensure_funnel()

    if host:
        ok, detail = public_ok(host)
        if not ok:
            log("public check failed for %s (%s), repairing" % (host, detail))
            run([TAILSCALE, "up"], timeout=120)
            run([TAILSCALE, "funnel", "--bg", PORT], timeout=60)
            ok, detail = public_ok(host)
            log("  after repair: %s (%s)" % (ok, detail))
            state["public_fail_streak"] = 0 if ok else state.get("public_fail_streak", 0) + 1
        else:
            if state.get("public_fail_streak"):
                log("public link healthy again (%s)" % detail)
            state["public_fail_streak"] = 0
        state["last_public"] = detail
    state["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")
    save_state(state)


if __name__ == "__main__":
    main()
