# TOST watcher (tesla-order-status)

Unattended Docker runner for [chrisi51/tesla-order-status](https://github.com/chrisi51/tesla-order-status)
(TOST), a CLI that reads your Tesla **order** status from Tesla's `owner-api` and records every change.
The container polls it with `--status` every 30 minutes, logs one line per poll and keeps the history on a
volume. Outbound HTTPS only, no ports published.

This directory is **not** part of the tesboard Worker or the telemetry stack; it runs on any host with Docker.
The upstream source is downloaded at build time from a pinned commit (`TOST_REF` in `Dockerfile`), not vendored.

## Setup

```sh
cd tesla-order-status
docker compose run --rm tost run   # builds the image, then the one-time interactive Tesla login
docker compose up -d               # start the watcher
docker compose logs -f
```

Login: open the printed URL in your own browser, sign in to Tesla, copy the full URL of the resulting
"Page Not Found" page back into the terminal, and answer **y** to both save prompts (tokens, order
information). `--status` needs both files.

## Usage

- Log lines: `status=0` no changes, `status=1` something changed (kept in the history), `status=-1` error or
  not logged in (repeat the login step).
- Full view, after login: `docker compose exec tost python tesla_order_status.py --cached`
  (no API call; also accepts `--details` / `--share`).
- `.env` next to `docker-compose.yml`: `TOST_INTERVAL_SECONDS` (default `1800`), `TZ` (default `Asia/Taipei`,
  used for log timestamps and the date stamped on history entries).
- Upgrade: bump `TOST_REF` in `Dockerfile`, then `docker compose up -d --build`.

## Notes

- The `tost-data` volume (`/app/data/private`) holds the Tesla tokens. They come from Tesla's `ownerapi` client
  and are not limited to read-only access, so treat the volume and any backup of it as an account credential.
- Seeded for unattended use (existing values are never overwritten): `update_method=block` (no self-update
  from GitHub `main`) and `telemetry-consent=false`. Change them in `settings.json` inside the volume.
- Polling only talks to `auth.tesla.com`, `owner-api.teslamotors.com` and `akamai-apigateway-vfx.tesla.com`.
  Interactive runs also fetch a banner and option-code names from `tesla-order-status-tracker.de`.
