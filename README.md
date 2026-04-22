# LG Local Remote

Native webOS Signage app for LG commercial displays. Exposes a small, LAN-bound HTTP API for remote screenshot capture and input switching. Target hardware: LG UH5Q professional display.

Canonical project notes live in the internal notes at `(internal notes)` and `(internal notes)`. This README only covers the repo-local build/deploy workflow.

## Repo layout

- `app/` — web app half of the IPK. Loads the SCAP library and will expose Luna endpoints for `captureScreen` / `InputSource.changeInputSource` (the service can't call these directly — Signage and InputSource families are not available on JS service).
- `service/` — JS (Node) service half. Owns the LAN HTTP listener, proxies capture/input requests to the web app via Luna.
- `scripts/` — thin wrappers around `ares-*` for setup, package, deploy.
- `docs/vendor/` — scraped LG partner-portal documentation, gitignored, local reference only.

App id: `com.lg.app.signage.dev` (developer mode naming — `.dev` suffix is required by webOS Signage dev mode).
Service id: `com.lg.app.signage.dev.remote`.

For production distribution via partner-signed IPK, these drop the `.dev` suffix: app = `com.lg.app.signage`, service = `com.lg.app.signage.remote`.

## Prerequisites

- Node + npm on host
- `@webos-tools/cli` 3.x installed globally, `ares-config -p signage`
- A paired device named `mypanel` (configure with `ares-setup-device` after enabling developer mode on the panel — see vault note)

## Workflow

```sh
./scripts/setup.sh          # no-op today; hook for future host deps
./scripts/build.sh          # ares-package app service → com.lg.app.signage.dev_0.0.1_all.ipk
./scripts/deploy.sh         # ares-install + ares-launch on DEVICE=mypanel
ares-inspect --device mypanel --service com.lg.app.signage.dev.remote
```

Health check once deployed (replace with device IP):

```sh
curl -s http://<device-ip>:9999/health | jq
```

## Status

M0 scaffolding with IDs and architecture now matching LG's documented requirements. `/screenshot` and `/input` endpoints in the service bounce to web-app Luna endpoints; the web-app endpoints are stubbed pending:
- SCAP library bundle (download from LG partner portal, matching UH5Q firmware)
- Physical access to the panel for developer mode + pairing
- Finalizing the web-app ↔ service Luna bridge pattern on real hardware
