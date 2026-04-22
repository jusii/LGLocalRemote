# LG Local Remote — HTTP API

LAN-bound HTTP API served by the `com.lg.app.signage.dev.remote` JS service
running inside the `com.lg.app.signage.dev` IPK on a webOS Signage panel.

- **Bind:** `0.0.0.0:9999` (LAN-reachable from any host on the same network).
- **Auth:** none in v1. Rely on LAN isolation. Do not expose beyond trusted networks.
- **Content-Type:** JSON for everything except `/screenshot` (image/jpeg or image/png).
- **Error shape:** `{ "ok": false, "error": "<code>", ...detail }`. HTTP status ≥ 400.

## `GET /health`

Liveness + uptime. Safe to poll.

**Request:** none.

**200:**
```json
{
  "ok": true,
  "service": "com.lg.app.signage.dev.remote",
  "version": "0.0.1",
  "uptimeSeconds": 42,
  "httpReady": true,
  "lastCapture": { "at": "2026-04-22T12:04:12.345Z", "bytes": 120543, "uri": "file://internal/...", "format": "JPEG" },
  "lastInput":   { "at": "2026-04-22T12:04:09.111Z", "type": "HDMI", "index": 0 }
}
```

`lastCapture` and `lastInput` are `null` until the respective endpoint has been called at least once.

## `GET /device`

Static platform facts pulled from IDCAP `configuration/property/get`. Useful for fleet inventory and as a canary that IDCAP-from-service is alive.

**Request:** none.

**200:**
```json
{
  "ok": true,
  "props": {
    "model_name": "43UH5Q-EQ.BEUGLJP",
    "serial_number": "XXXXXXXXXXXX",
    "firmware_version": "03.34.12",
    "platform_version": "9.0.0-146",
    "webos_version": "9.0.0",
    "idpn": 410,
    "idcap_js_extension_version": "1.1.1"
  }
}
```

Any individual property that fails resolves to `{ "_error": { ... } }` in its slot but doesn't fail the whole response. Exact property names come from the IDCAP "Properties" mapping table (see vendor docs).

## `GET /screenshot`

Captures the panel's current framebuffer via IDCAP (`idcap://utility/screen/capture`), reads the resulting file (`idcap://storage/file/read`), and streams the bytes as the HTTP body.

**Query parameters** (all optional):

| Param | Type | Range | Default | Notes |
|-------|------|-------|---------|-------|
| `format` | `JPEG` \| `PNG` | — | `JPEG` | Response content-type matches |
| `width`  | integer | 128–1920 | 1280 | |
| `height` | integer | 72–1080  | 720  | |

**200:** Raw image bytes. Response headers:
- `Content-Type: image/jpeg` (or `image/png`)
- `Content-Length: <bytes>`
- `X-Capture-Uri: file://...` (IDCAP URI of the saved file, for debugging)

**502:**
```json
{ "ok": false, "error": "capture_failed", "detail": { "errorMessage": "..." }, "captureUri": "file://..." }
```

### Examples

```sh
curl -s http://<panel-ip>:9999/screenshot -o shot.jpg
curl -s "http://<panel-ip>:9999/screenshot?format=PNG&width=1920&height=1080" -o shot.png
```

### Caveats

- **HDCP-protected content cannot be captured.** External HDMI from a protected source returns an IDCAP error.
- FHD capture + JPEG read round-trip takes ~1–3 seconds in practice.
- For images larger than ~1 MB, file/read slows noticeably. If this becomes a problem we'll switch to fetching via `http://127.0.0.1:9080/<path>` from inside the service.

## `GET /input`

Returns the current audio/video input plus the full list of available inputs and their signal-detection state.

**Request:** none.

**200:**
```json
{
  "ok": true,
  "current": { "type": "HDMI", "index": 0 },
  "currentInputPort": "ext://hdmi:1",
  "count": 4,
  "inputs": [
    { "inputPort": "ext://hdmi:1", "signalDetection": true,  "type": "HDMI", "index": 0 },
    { "inputPort": "ext://hdmi:2", "signalDetection": false, "type": "HDMI", "index": 1 },
    { "inputPort": "ext://dp:1",   "signalDetection": false, "type": "RGB",  "index": 0 },
    { "inputPort": "ext://ops:1",  "signalDetection": false, "type": "OTHERS","index": 0 }
  ]
}
```

`inputs` is `null` and `inputListError` is populated when the `inputlist/get` call fails (the current input is returned either way).

**502:** `{ "ok": false, "error": "get_input_failed", "detail": {...} }`.

## `POST /input`

Switch the active input. Accepts either the native IDCAP shape or a shorter URI form.

**Request body** (JSON, pick one form):

```json
{ "type": "HDMI", "index": 0 }
```

or

```json
{ "src": "ext://hdmi:1" }
```

The URI form maps `hdmi` → `HDMI`, `dp|dvi|rgb` → `RGB`, `ops|others` → `OTHERS`, `svideo`/`component`/`composite`/`scart` similarly. Port number `N` in `ext://.../:N` maps to IDCAP `index: N-1`.

**200:** `{ "ok": true, "set": { "type": "HDMI", "index": 0 } }`.

**400:**
- `{ "ok": false, "error": "invalid_json" }` — request body isn't valid JSON
- `{ "ok": false, "error": "missing_input", "example": { "type": "HDMI", "index": 0 } }`
- `{ "ok": false, "error": "bad_src", "expected": "ext://hdmi:1 | ext://dp:1 | ..." }`
- `{ "ok": false, "error": "unknown_src_scheme", "scheme": "..." }`

**502:** `{ "ok": false, "error": "set_input_failed", "requested": {...}, "detail": {...} }`.

## `POST /kill` (dev only)

Exits the service process so the next `ares-launch` picks up new code. Used by `scripts/deploy.sh` as a hot-reload mechanism since webOS JS services holding a TCP listener don't idle-time-out.

**200:** `{ "ok": true, "bye": true }` (service exits ~200ms after responding).

No authentication. Exposed on the same LAN port as the rest of the API. Remove before any production/customer-facing deployment.

## Error taxonomy

| HTTP | `error` | Meaning |
|------|---------|---------|
| 400 | `invalid_json` | Request body wasn't JSON |
| 400 | `missing_input` | POST /input had neither `{type,index}` nor `{src}` |
| 400 | `bad_src` | `src` didn't match `ext://scheme:N` |
| 400 | `unknown_src_scheme` | Scheme part of `src` isn't recognized |
| 404 | `not_found` | No endpoint matches the request |
| 502 | `capture_failed` | IDCAP capture or file/read error |
| 502 | `no_uri` | IDCAP capture returned no uri field |
| 502 | `no_data` / `empty_data` / `decode_failed` | IDCAP file/read returned nothing usable |
| 502 | `get_input_failed` | IDCAP externalinput/get error |
| 502 | `set_input_failed` | IDCAP externalinput/set error |
| 504 | *(not emitted — IDCAP calls have an internal 15s timeout surfaced via 502 `idcap_timeout`)* | |

## Platform notes

- Target hardware: LG UH5Q signage. Verified on **43UH5Q-EQ.BEUGLJP**, webOS **9.0.0-146**, IDPN 4xx. Should work on any webOS Signage 6.0+ panel where IDCAP is available.
- IDCAP middleware on the device: `com.webos.service.commercial.scapadapter`. All calls route via `luna://com.webos.service.idcapmw.mwcommand/callidcap`.
- Source IDCAP reference: `idcap://utility/screen/capture`, `idcap://externalinput/{get,set}`, `idcap://externalinput/inputlist/get`, `idcap://storage/file/read`.
