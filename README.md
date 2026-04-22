# LG Local Remote

Native webOS Signage app for LG commercial displays. Exposes a small, LAN-bound HTTP API for remote screenshot capture and HDMI-input switching. Target hardware: LG UH5Q professional display (43" 43UH5Q-EQ.BEUGLJP verified).

**Full API reference:** [docs/API.md](docs/API.md).

**Canonical project notes** live in the internal notes:
- `(internal notes)` — scope, decisions, milestones, gotchas
- `(internal notes)` — IDCAP/SCAP API summary for this project and future LG work
- `(internal notes)` — dev tooling, developer-mode procedure, pairing

## Architecture

```
HTTP client (LAN) ──HTTP──▶ JS service ──IDCAP──▶ panel middleware
                    ▲        (idcap.js Node mode)     (luna://com.webos.service.idcapmw.mwcommand/callidcap)
                    │
                 port 9999
                    │
                    ▼
             Web app (status UI only — no app logic)
```

- **JS service** (`service/`) — Node, owns the HTTP listener, loads `idcap.js` (Node mode), calls IDCAP directly for capture + input switching.
- **Web app** (`app/`) — webOS web app. Thin status page using `webOS.js` to ping the service every 3 s.
- The JS service is what does the work. The web app is mostly there so the IPK has an app surface to launch.

Both packaged into a single IPK via `ares-package app service`.

## Repo layout

```
.
├── app/
│   ├── appinfo.json          # id: com.lg.app.signage.dev
│   ├── index.html            # status UI
│   ├── icon.png / largeIcon.png
│   └── js/
│       ├── webOS.js          # Luna bridge for web app → service
│       └── idcap/idcap.js    # IDCAP library (bundled but not used by the web app today)
├── service/
│   ├── package.json          # name: com.lg.app.signage.dev.remote
│   ├── services.json         # Luna service registration
│   ├── service.js            # HTTP server + IDCAP calls
│   └── idcap.js              # same IDCAP library, Node mode
├── scripts/
│   ├── setup.sh              # no-op today
│   ├── build.sh              # ares-package → *.ipk
│   ├── deploy.sh             # /kill old service → ares-install → ares-launch
│   ├── test.sh               # smoke-test the live HTTP API
│   └── _nvm.sh               # sourced; auto-switches to .nvmrc Node version
├── docs/
│   ├── API.md                # HTTP endpoint spec
│   └── vendor/               # scraped LG partner docs (gitignored)
├── .nvmrc                    # pins Node 20 (ares-cli breaks on Node 22+)
└── .gitignore                # excludes docs/vendor, cookies.txt, *.ipk, node_modules, .claude
```

App id: `com.lg.app.signage.dev` · Service id: `com.lg.app.signage.dev.remote`.

For production (not dev-mode) distribution, drop the `.dev` from both and sign via the LG partner portal.

## Prerequisites

- **Node 20 LTS** — ares-cli breaks on Node 22+ (`util.isDate` removed). Pinned via `.nvmrc`; scripts auto-switch if you have nvm.
- **`@webos-tools/cli` 3.x** — `npm i -g @webos-tools/cli && ares-config -p signage`.
- **Paired device** — profile named `mypanel` in `~/.webos/signage/novacom-devices.json`. Pairing steps in the vault's `Software.md`.

## Day-to-day workflow

```sh
./scripts/build.sh       # package IPK
./scripts/deploy.sh      # self-kill old service → install → launch
./scripts/test.sh        # curl /health, /input, /screenshot against the panel
```

`deploy.sh` POSTs `/kill` to the running service before installing so new code takes effect on the next launch. First-ever rollout (before any `/kill`-capable service exists on the panel) needs a one-time manual reboot of the panel to clear the old service process.

Handy one-liners:

```sh
DEVICE=mypanel ares-install --list        # list installed packages
DEVICE=mypanel ares-launch --close com.lg.app.signage.dev   # stop app (doesn't stop service)
ares-inspect --device mypanel --app com.lg.app.signage.dev  # Chrome DevTools on the web app
ares-inspect --device mypanel --service com.lg.app.signage.dev.remote  # Node inspector on the service
ares-novacom --device mypanel --run "ps aux | grep signage"  # peek at process state
```

## Status

- [x] M0 — dev tooling + pairing + hello-world IPK
- [x] M1 — HTTP server running in-IPK, `/health` reachable over LAN
- [ ] M2 — `/screenshot` end-to-end (wired; awaits panel reboot + re-verify)
- [ ] M3 — `/input` GET/POST end-to-end (wired; awaits reboot + re-verify)
- [ ] M4 — register as the panel's SI app so it survives HDMI input switches + reboots; production IPK signing

## Known gotchas

See the vault (`(internal notes)` and `LG Local Remote.md → Known-current deploy gotchas`) for:
- JS services with open TCP listeners never idle out — use `/kill` endpoint or reboot
- HDMI input switch kills custom SI app; need to reinstall until M4
- Dev-installed IPKs don't appear as Smart Home tiles (normal)
- `ares-cli` on signage profile lacks `ares-shell` / `ares-device -i` / `ares-log`
- Signage `--getkey` produces an AES-encrypted key; passphrase must live in the device profile

## Public library sources

Both fetched into the repo during setup. Public (no partner login):

- `webOS.js` — `https://res.cloudinary.com/dcsdn4mzr/raw/upload/v1689918830/webOS-Signage/assets/library/guide/webOS.zip`
- IDCAP library — `https://res.cloudinary.com/dcsdn4mzr/raw/upload/v1/webOS-Signage/assets/library/apis/IDCAP_DOC_PORTABLE.zip`
