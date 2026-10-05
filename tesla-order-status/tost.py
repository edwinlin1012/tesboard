#!/usr/bin/env python3
"""Container entrypoint for TOST (chrisi51/tesla-order-status).

  watch          poll `--status` every TOST_INTERVAL_SECONDS and log the result (default)
  run [args...]  hand the arguments to the upstream CLI (login, --cached, --details, ...)
"""
import json
import os
import signal
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

APP_DIR = Path("/app")
SETTINGS = APP_DIR / "data" / "private" / "settings.json"

# Unattended defaults, existing values win: no self-update from GitHub, no telemetry
DEFAULTS = {"update_method": "block", "telemetry-consent": False}

STATUS_TEXT = {
    "0": "no changes",
    "1": "CHANGES DETECTED -> docker compose exec tost python tesla_order_status.py --cached",
    "2": "update pending",
    "-1": "error or not logged in -> docker compose run --rm tost run",
}

POLL_TIMEOUT = 300
stop = threading.Event()


def log(message):
    print(f"{datetime.now().astimezone().isoformat(timespec='seconds')} {message}", flush=True)


def seed_settings():
    cfg = {}
    if SETTINGS.exists():
        try:
            cfg = json.loads(SETTINGS.read_text(encoding="utf-8"))
        except ValueError:
            return
    missing = {key: value for key, value in DEFAULTS.items() if key not in cfg}
    if missing:
        SETTINGS.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS.write_text(json.dumps({**cfg, **missing}, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def poll():
    # With telemetry off the CLI re-asks for consent every 10th run; answer it so stdin never blocks
    try:
        result = subprocess.run(
            [sys.executable, "tesla_order_status.py", "--status"],
            cwd=APP_DIR, input="n\n\n", capture_output=True,
            encoding="utf-8", errors="replace", timeout=POLL_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        log(f"status=-1 poll timed out after {POLL_TIMEOUT}s")
        return
    words = result.stdout.split()
    code = words[-1] if words else ""
    if code in STATUS_TEXT:
        log(f"status={code} {STATUS_TEXT[code]}")
    else:
        detail = " | ".join((result.stderr or result.stdout).strip().splitlines()[-3:])
        log(f"status=-1 unexpected output (exit {result.returncode}): {detail}")


def watch():
    interval = max(10, int(os.environ.get("TOST_INTERVAL_SECONDS", "1800")))
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    log(f"watching every {interval}s" + (" (short interval, Tesla may rate-limit)" if interval < 300 else ""))
    while not stop.is_set():
        poll()
        stop.wait(interval)
    log("stopped")


def run(args):
    os.chdir(APP_DIR)
    os.execv(sys.executable, [sys.executable, "tesla_order_status.py", *args])


def main():
    seed_settings()
    command, *args = sys.argv[1:] or ["watch"]
    if command == "watch":
        watch()
    elif command == "run":
        run(args)
    else:
        sys.exit("usage: tost.py [watch | run [upstream args...]]")


if __name__ == "__main__":
    main()
