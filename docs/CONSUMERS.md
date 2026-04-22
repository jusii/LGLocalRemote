# For consumers

Drop this into another project's `CLAUDE.md` (or paste into a Claude session) when you want to screenshot HDMI output from the lab's LG panel for analysis.

Canonical version with more gotchas + recovery steps is in the internal notes at `(internal notes)` — prefer that if the obsidian-vault MCP is available.

---

## Screenshotting HDMI output on the lab's LG panel

The lab has an **LG 43UH5Q** signage panel at `<panel-host>` (IP `<panel-ip>`). It runs a custom service (`LG Local Remote`, port 9999) that lets you render any HDMI input inside an overlay and capture it as a JPEG/PNG. Useful for seeing what your Pi / NUC / dev board is actually outputting.

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

- **Don't use `POST /input`** to switch the panel's physical input. That triggers a hardware input change which kills our SI app and takes the API offline. Use `POST /view` (overlay inside the app) — never `POST /input` — unless you know what you're doing.
- **Don't forget to clear `/view`** when done. It's cosmetic (panel eventually recovers) but polite.

### Caveats

- **HDCP-protected content renders black.** Most streaming dongles and some game consoles mark their HDMI output HDCP-protected — in that case both the video element and the capture come back black. For DIY devices (Pi, NUC, ESP32) HDCP is off by default. The protection can only be disabled on the source, not the panel.
- **~3 s total round-trip** (HTTP + the 2s sync wait).
- **Current physical input is preserved.** `POST /view` does not change what the panel's viewer sees — it just overlays the feed inside our app for capture purposes.

### Query parameters on `/screenshot`

| Param | Range | Default | Notes |
|-------|-------|---------|-------|
| `format` | `JPEG` \| `PNG` | `JPEG` | Response Content-Type matches |
| `width`  | 128–1920 | 1280 | |
| `height` | 72–1080  | 720  | |

### Service is refusing port 9999

The app was killed — probably someone physically switched the HDMI input or issued a rogue `POST /input`. Relaunch:

```sh
ares-launch --device mypanel com.lg.app.signage.dev
```

Requires `@webos-tools/cli` + a paired device profile. If you don't have pairing, ask the human.

### Other endpoints (in case you need them)

| Method + path | Purpose |
|---------------|---------|
| `GET /health` | Uptime, version, last capture, last input |
| `GET /device` | Model, serial, firmware, webOS version, IDPN |
| `GET /input` | Current physical input + full list of all 4 with signal detection |
| `POST /input` | **Dangerous.** Physically switches the panel's input, kills our app. Prefer `/view`. |
| `GET /view` | Current view-overlay state |
| `POST /view` | Set the view-overlay (`{src: "ext://hdmi:3"}` or `{src: null}` to clear) |

Full reference: `~/Devel/LGLocalRemote/docs/API.md` on the dev machine.
