# LG Local Remote

> A tiny HTTP API for LG webOS Signage displays. Screenshot the panel, switch HDMI inputs, and view an external HDMI source inside the app — all over LAN, no cloud, no vendor portal.

Pack a native webOS Signage IPK that exposes a small REST API on the panel. Aimed at lab benches, kiosk fleets, CI rigs, and AI coding agents that need eyes on what an HDMI-output device is actually rendering — all without standing in front of the panel with a remote.

```
HTTP client (LAN) ──HTTP──▶ JS service ──IDCAP──▶ panel middleware
                    ▲        (idcap.js Node mode)     (luna://com.webos.service.idcapmw.mwcommand/callidcap)
                    │
                 port 9999
                    │
                    ▼
             Web app (status UI + HDMI overlay)
```

---

## Features

- **`GET /screenshot`** — capture the panel's current framebuffer (JPEG/PNG, configurable resolution).
- **`POST /input`** — switch the panel's active a/v input (HDMI1..N, DP, OPS, …).
- **`POST /view`** — render any HDMI input as a fullscreen `<video>` inside the app, without physically switching the panel input (so the API stays alive and you can screenshot the feed).
- **`GET /input`** / **`GET /view`** — read current state including per-input signal-detection.
- **`GET /device`** — model, serial, firmware, webOS version, IDPN (useful for fleet inventory).
- **`GET /health`** — uptime, last capture, last input change.
- **`GET /`** — a self-contained dev control UI served straight from the service.

Full endpoint reference: [docs/API.md](docs/API.md). Driving the API from another project (or a coding-agent session) to capture HDMI output: [docs/CONSUMERS.md](docs/CONSUMERS.md).

## Why this matters for AI-driven development

Coding agents like Claude Code, Cursor, and Aider can read images. With this service running on a panel wired to your dev device, an agent working on software for an HDMI-output target — a Raspberry Pi kiosk, a NUC running signage content, a game-console homebrew app, an embedded board's UI, anything that ends in a video signal — can close its own visual feedback loop:

```sh
# Agent's tool calls, no human needed in the loop:
curl -s -X POST -H 'content-type: application/json' \
  -d '{"src":"ext://hdmi:3"}' http://$PANEL:9999/view
sleep 2
curl -s "http://$PANEL:9999/screenshot?format=PNG" -o /tmp/check.png
# …then Read /tmp/check.png — modern agents see the image directly.
```

The agent edits code, deploys, screenshots the panel, *sees* the result, and iterates. "I changed the layout — please tell me what's on screen" becomes a self-verifying step. [docs/CONSUMERS.md](docs/CONSUMERS.md) is a drop-in cheat-sheet for pasting into another project's `CLAUDE.md` or a fresh agent session.

Why this specific tool vs. a USB capture card on the dev machine:

- **The panel sees what an end user sees.** What you capture is the actual production rendering pipeline, including any HDMI-handshake quirks of the real display.
- **No new hardware** if you already have an LG commercial display in the lab.
- **`POST /view` doesn't disturb the viewer** — the agent can inspect HDMI3 while HDMI2 is still being shown on the panel for someone else.
- **LAN-only, no auth, no cloud, no API keys** — drop the URL into the agent's environment and go.
- **Cheap, parallel-safe-ish** — ~1 capture/second sustained, plenty for an iterative agent loop. (See [docs/CONSUMERS.md](docs/CONSUMERS.md) for measured limits.)

## Status

Working and used day-to-day for HDMI capture in a small dev lab. Verified on an LG **43UH5Q-EQ.BEUGLJP** running webOS Signage **9.0.0-146**. Should work on any webOS Signage 6.0+ panel where IDCAP is available.

This is a developer / lab tool: **no authentication**, **LAN-only by design**, and it ships in webOS dev mode (no LG partner signing required). Do not expose port 9999 to the public internet.

## Quick start

### Prerequisites

- A paired LG webOS Signage display in [developer mode](https://webostv.developer.lge.com/develop/app-test/using-devmode-app/).
- **Node 20 LTS** on your dev machine. ares-cli breaks on Node 22+ (`util.isDate` was removed). Pinned via `.nvmrc`; the build scripts auto-switch if you have nvm.
- **[@webos-tools/cli](https://www.npmjs.com/package/@webos-tools/cli) 3.x**:
  ```sh
  npm i -g @webos-tools/cli
  ares-config -p signage          # pick the "signage" profile
  ares-setup-device               # pair your panel; remember the profile name
  ```

### Build & deploy

```sh
git clone https://github.com/<you>/LGLocalRemote.git
cd LGLocalRemote

# Tell the scripts which paired device to target (default: "mypanel").
export DEVICE=<your-paired-device-name>

./scripts/build.sh              # → ./com.lg.app.signage.dev_0.0.1_all.ipk
./scripts/deploy.sh             # install + launch on $DEVICE
./scripts/test.sh               # smoke-test /health, /input, /screenshot
```

`scripts/deploy.sh` POSTs `/kill` to the running service before re-installing, so new code takes effect on the next launch. The first ever rollout (when no `/kill`-capable service exists yet) needs a one-time manual reboot of the panel to clear any prior service process.

### Hello world

```sh
PANEL=<your-panel-host-or-ip>

# What's the panel?
curl -s http://$PANEL:9999/health | jq .

# Grab a screenshot
curl -s "http://$PANEL:9999/screenshot?format=PNG&width=1920&height=1080" -o shot.png

# Show what HDMI3 is outputting (overlay the feed inside the app, then capture)
curl -s -X POST -H 'content-type: application/json' \
  -d '{"src":"ext://hdmi:3"}' http://$PANEL:9999/view
sleep 2
curl -s "http://$PANEL:9999/screenshot?format=JPEG" -o hdmi3.jpg
curl -s -X POST -H 'content-type: application/json' \
  -d '{"src":null}' http://$PANEL:9999/view
```

## How it works

Two pieces in one IPK:

- **JS service** (`service/`) — Node-mode webOS service. Owns the HTTP listener on port 9999. Loads the IDCAP library in Node mode and calls IDCAP middleware directly for screen capture (`idcap://utility/screen/capture`) and input switching (`idcap://externalinput/{get,set}`).
- **Web app** (`app/`) — webOS web app. Mostly a thin status page; also renders a fullscreen `<video src="ext://hdmi:N" type="service/webos-external" texture>` overlay when `POST /view` asks it to. The `texture` attribute is the trick that makes the external HDMI feed visible to screen capture instead of being composited on a separate hardware plane.

The web app polls the service every second via Luna (`luna://com.lg.app.signage.dev.remote/ping`), so the overlay reacts to `POST /view` within ~1s.

## Repo layout

```
.
├── app/
│   ├── appinfo.json          # id: com.lg.app.signage.dev
│   ├── index.html            # status UI + HDMI overlay
│   ├── icon.png / largeIcon.png
│   └── js/
│       ├── webOS.js          # Luna bridge for web app → service (LG-published)
│       └── idcap/idcap.js    # IDCAP library, browser mode (LG-published)
├── service/
│   ├── package.json          # name: com.lg.app.signage.dev.remote
│   ├── services.json         # Luna service registration
│   ├── service.js            # HTTP server + IDCAP calls
│   ├── index.html            # dev control UI served from GET /
│   └── idcap.js              # same IDCAP library, Node mode
├── scripts/
│   ├── setup.sh              # no-op today (no host npm deps)
│   ├── build.sh              # ares-package → *.ipk
│   ├── deploy.sh             # /kill old service → ares-install → ares-launch
│   ├── test.sh               # smoke-test the live HTTP API
│   └── _nvm.sh               # sourced; auto-switches to .nvmrc Node version
├── docs/
│   └── API.md                # HTTP endpoint spec
├── .nvmrc                    # pins Node 20
└── LICENSE                   # MIT
```

## Handy ares-cli one-liners

```sh
ares-install --device $DEVICE --list                           # list installed packages
ares-launch  --device $DEVICE --close com.lg.app.signage.dev    # stop app (doesn't stop service)
ares-inspect --device $DEVICE --app com.lg.app.signage.dev      # Chrome DevTools on the web app
ares-inspect --device $DEVICE --service com.lg.app.signage.dev.remote  # Node inspector on the service
```

## Known gotchas

- **JS services with open TCP listeners never idle out** on webOS Signage — use the `POST /kill` endpoint or reboot to free the port. `scripts/deploy.sh` handles this for you.
- **Switching the panel's physical input via `POST /input` kills the custom SI app** until it's relaunched (or until you register it as the panel's SI app). Prefer `POST /view` for capture, which keeps the panel in SI mode and the API alive.
- **HDCP-protected HDMI content cannot be captured.** External HDMI from a protected source comes back black or returns an IDCAP error. For DIY devices (Pi, NUC, ESP32) HDCP is off by default.
- **FHD capture + JPEG read round-trip takes ~1–3 s.** IDCAP middleware deduplicates in-flight requests, so concurrent screenshot calls return duplicate frames. Keep captures serial.
- **Dev-installed IPKs don't appear as Smart Home tiles** — normal in dev mode.
- **`ares-cli` on the signage profile lacks `ares-shell`, `ares-device -i`, and `ares-log`** — quirks of the signage profile vs the TV profile.

## Why the app id is `com.lg.app.signage.dev`

webOS Signage developer mode **whitelists exactly one app id for sideload-installable apps**: `com.lg.app.signage.dev`. Trying to install any other id fails with `Can install only 'com.lg.app.signage.dev' app on developer mode`. The id sitting in `com.lg.*` looks like it's claiming LG's reverse-DNS namespace, but it's just LG's own dev-mode magic id — we're not free to pick our own here.

For production (signed) deployment you'd drop the `.dev` suffix and use whatever id the LG partner portal issues for your account.

## Going to production

This repo ships in webOS dev mode: unsigned, dev-mode-reserved app id, and a `POST /kill` endpoint that's only intended for local development. Before any production / customer-facing deployment you should at minimum:

1. Drop the `POST /kill` endpoint from `service/service.js`.
2. Add authentication or a network-level allowlist in front of port 9999.
3. Sign the IPK via the LG partner portal so it survives reboots without dev-mode renewal, can be registered as the panel's SI app (so it persists across HDMI input switches), and so you can use your own app id instead of `com.lg.app.signage.dev`.

## Acknowledgments

- **`app/js/webOS.js`** and **`app/js/idcap/idcap.js`** are publicly-distributed LG libraries, included here for convenience. Original sources:
  - webOS Signage JS: `https://res.cloudinary.com/dcsdn4mzr/raw/upload/v1689918830/webOS-Signage/assets/library/guide/webOS.zip`
  - IDCAP JS extension: `https://res.cloudinary.com/dcsdn4mzr/raw/upload/v1/webOS-Signage/assets/library/apis/IDCAP_DOC_PORTABLE.zip`
- LG and webOS are trademarks of LG Electronics, Inc. This project is not affiliated with or endorsed by LG.

## License

[MIT](LICENSE) — the project's own code (everything under `app/` except `app/js/`, all of `service/` except `service/idcap.js`, all of `scripts/`, and `docs/`). The bundled LG libraries listed under Acknowledgments are © LG Electronics, redistributed under LG's original terms.
