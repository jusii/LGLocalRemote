# For consumers

Drop this into another project's `CLAUDE.md` (or paste into a Claude / coding-agent session) when you want to screenshot HDMI output from an LG panel running LG Local Remote — typically to give the agent eyes on what a Pi / NUC / dev board is actually rendering.

---

## Screenshotting HDMI output on a panel running LG Local Remote

The panel exposes an HTTP API on port 9999 that can render any HDMI input inside an overlay and capture the result as a JPEG/PNG. The panel stays in SI mode the whole time, so the service doesn't get killed and you don't need to physically switch inputs.

Replace `<panel-host>` with the panel's hostname or IP (e.g. `panel.local`, `192.168.x.x`) and `<hdmi-N>` with the input you want (`hdmi:1..4`, `dp:1`, `dvi:1`, `ops:1`).

### Do

```sh
BASE="http://<panel-host>:9999"
INPUT="ext://hdmi:3"   # hdmi:1..4, dp:1, dvi:1, ops:1
OUT="/tmp/panel.jpg"

# 1. Overlay the HDMI feed inside the app (panel stays in SI mode; does NOT physically switch inputs).
curl -sS -X POST -H 'content-type: application/json' -d "{\"src\":\"$INPUT\"}" "$BASE/view" >/dev/null

# 2. Give the decoder ~2s to sync.
sleep 2

# 3. Capture.
curl -sS "$BASE/screenshot?format=JPEG&width=1920&height=1080" -o "$OUT"

# 4. Politely clear the overlay back to status UI when done.
curl -sS -X POST -H 'content-type: application/json' -d '{"src":null}' "$BASE/view" >/dev/null
```

Then `Read` `/tmp/panel.jpg` — Claude can see images directly.

### Don't

- **Don't use `POST /input`** to switch the panel's physical input. That triggers a hardware input change which kills the SI app and takes the API offline. Use `POST /view` (overlay inside the app) — never `POST /input` — unless you know what you're doing.
- **Don't forget to clear `/view`** when done. It's cosmetic (panel eventually recovers) but polite.

### Throughput / rate limits

Measured against live HDMI content (distinct frames, real motion):

| Size | Latency | Sustainable rate |
|------|---------|-------------------|
| JPEG 1280×720 | ~0.70 s | ~1.4 captures/s (≈ 84/min) |
| JPEG 1920×1080 | ~1.38 s | ~0.7 captures/s (≈ 42/min) |

**Do not run concurrent captures.** IDCAP middleware deduplicates in-flight requests — 10 parallel 720p calls measured returned only 3 unique frames (one was handed to 7 of 10 requests). Concurrency raises latency AND returns duplicates. Keep it serial and sleep between captures equal to the measured latency. If the panel is shared lab equipment, don't leave polling loops running forever.

Fast rule of thumb:
- **1 Hz** is safe at either resolution.
- **~1.5 Hz at 720p** / **~0.7 Hz at 1080p** is the distinct-frame ceiling.
- Anything above that — the pipeline isn't designed for it.

### Caveats

- **HDCP-protected content renders black.** Most streaming dongles and some game consoles mark their HDMI output HDCP-protected — in that case both the video element and the capture come back black. For DIY devices (Pi, NUC, ESP32) HDCP is off by default. The protection can only be disabled on the source, not the panel.
- **~3 s total round-trip** (HTTP + the 2s sync wait).
- **Current physical input is preserved.** `POST /view` does not change what the panel's viewer sees — it just overlays the feed inside the app for capture purposes.

### Query parameters on `/screenshot`

| Param | Range | Default | Notes |
|-------|-------|---------|-------|
| `format` | `JPEG` \| `PNG` | `JPEG` | Response Content-Type matches |
| `width`  | 128–1920 | 1280 | |
| `height` | 72–1080  | 720  | |

### Service is refusing port 9999

The app was killed — probably someone physically switched the HDMI input or issued a rogue `POST /input`. Relaunch from a machine paired with the panel (see the project README for pairing):

```sh
ares-launch --device <your-paired-device-name> com.lg.app.signage.dev
```

Requires `@webos-tools/cli` + a paired device profile. If you don't have pairing, ask whoever set the panel up.

### Other endpoints (in case you need them)

| Method + path | Purpose |
|---------------|---------|
| `GET /health` | Uptime, version, last capture, last input |
| `GET /device` | Model, serial, firmware, webOS version, IDPN |
| `GET /input` | Current physical input + full list of inputs with signal detection |
| `POST /input` | **Dangerous.** Physically switches the panel's input, kills the SI app. Prefer `/view`. |
| `GET /view` | Current view-overlay state |
| `POST /view` | Set the view-overlay (`{src: "ext://hdmi:3"}` or `{src: null}` to clear) |

Full reference: [docs/API.md](API.md).
