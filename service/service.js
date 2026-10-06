'use strict';

// webos-service is provided by the device runtime (not npm); this service only
// runs on-device. Running `node service.js` on the host fails at this require.
var Service = require('webos-service');
var IDCAP = require('./idcap.js');
var http = require('http');
var fs = require('fs');

var SERVICE_NAME = 'com.lg.app.signage.dev.remote';
var HTTP_PORT = 9999;
var VERSION = '0.0.1';
var IDCAP_TIMEOUT_MS = 15000;

// Dev UI: control page served from `GET /`. Read once at startup so we don't
// re-stat the file on every request. If the file is missing for any reason
// (shouldn't happen — it ships in the IPK alongside service.js), GET / returns
// a small fallback error instead of crashing the service.
var INDEX_HTML = null;
var INDEX_HTML_ERR = null;
try {
    INDEX_HTML = fs.readFileSync(__dirname + '/index.html', 'utf8');
} catch (e) {
    INDEX_HTML_ERR = e && e.message ? e.message : String(e);
    console.error('Failed to load index.html:', INDEX_HTML_ERR);
}

var service = new Service(SERVICE_NAME);
var idcap = new IDCAP(service);

var state = {
    startedAt: Date.now(),
    httpPort: HTTP_PORT,
    listenError: null,
    lastCapture: null,    // { at, bytes } | null
    lastInput: null,      // { at, type, index } | null — last input CHANGE (POST /input only)
    view: null            // null = show app status; { src: "ext://hdmi:N", setAt } to render an input
};

function uptimeSeconds() {
    return Math.floor((Date.now() - state.startedAt) / 1000);
}

// --- Luna method for web app status ping ---
service.register('ping', function (message) {
    message.respond({
        returnValue: true,
        service: SERVICE_NAME,
        version: VERSION,
        httpPort: HTTP_PORT,
        httpReady: state.listenError == null,
        uptimeSeconds: uptimeSeconds(),
        lastCapture: state.lastCapture,
        lastInput: state.lastInput,
        view: state.view
    });
});

// --- IDCAP helpers: promise with timeout + uniform error shape ---
function idcapCall(uri, params, timeoutMs) {
    var limit = timeoutMs || IDCAP_TIMEOUT_MS;
    return new Promise(function (resolve, reject) {
        var settled = false;
        var to = setTimeout(function () {
            if (!settled) { settled = true; reject({ error: 'idcap_timeout', uri: uri, timeoutMs: limit }); }
        }, limit);
        idcap.request(uri, {
            parameters: params || {},
            onSuccess: function (cb) {
                if (!settled) { settled = true; clearTimeout(to); resolve(cb); }
            },
            onFailure: function (err) {
                if (!settled) { settled = true; clearTimeout(to); reject(err); }
            }
        });
    });
}

// --- HTTP helpers ---
function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function sendJpeg(res, base64, size) {
    var buf = Buffer.from(base64, 'base64');
    res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        'X-Captured-Size': String(size || buf.length)
    });
    res.end(buf);
}

function getIdcapProperties(keys, timeoutMs) {
    // Issue a parallel get for each key; tolerate per-key failures.
    return Promise.all(keys.map(function (key) {
        return idcapCall('idcap://configuration/property/get', { key: key }, timeoutMs)
            .then(function (cb) { return [key, cb && (cb.value != null ? cb.value : cb[key] != null ? cb[key] : cb)]; })
            .catch(function (err) { return [key, { _error: err }]; });
    })).then(function (pairs) {
        return pairs.reduce(function (acc, p) { acc[p[0]] = p[1]; return acc; }, {});
    });
}

// --- endpoint handlers ---
function handleDevice(res) {
    getIdcapProperties([
        'model_name', 'serial_number', 'firmware_version',
        'platform_version', 'webos_version', 'idpn',
        'idcap_js_extension_version'
    ]).then(function (props) {
        sendJson(res, 200, { ok: true, props: props });
    }).catch(function (err) {
        sendJson(res, 502, { ok: false, error: 'device_info_failed', detail: err });
    });
}

function handleHealth(res) {
    // Display/picture are read live from the panel with a short timeout so a
    // stuck IDCAP bridge can't stall /health; failures land in the field.
    Promise.all([
        getDisplayMode(HEALTH_IDCAP_TIMEOUT_MS).catch(function (e) { return { error: e }; }),
        getPicture(HEALTH_IDCAP_TIMEOUT_MS).catch(function (e) { return { error: e }; })
    ]).then(function (r) {
        sendJson(res, 200, {
            ok: true,
            service: SERVICE_NAME,
            version: VERSION,
            uptimeSeconds: uptimeSeconds(),
            httpReady: state.listenError == null,
            lastCapture: state.lastCapture,
            lastInput: state.lastInput,
            view: state.view,
            display: displayReport(r[0]),
            picture: pictureReport(r[1])
        });
    });
}

// --- display blanking + picture dimming ---
// Blanking uses idcap://system/display/mute ("screen off" | "active"): panel
// only, main power stays on, input untouched (IDCAP equivalent of SCAP
// Power.setDisplayMode). Picture uses idcap://configuration/property with the
// backlight/brightness/contrast keys (IDCAP equivalent of SCAP
// Configuration.setPictureProperty). Nothing here touches power modes, DPM,
// auto-standby or the 15-min-off feature.
//
// The pending auto-restore and the "night" snapshot persist to a small file
// so they survive a service restart (not a panel reboot: it's under tmpdir).
var HEALTH_IDCAP_TIMEOUT_MS = 3000;
var DISPLAY_RETRY_MS = 60000;
var MAX_FOR_MINUTES = 24 * 60;
var PICTURE_KEYS = ['backlight', 'brightness', 'contrast'];
var NIGHT_DEFAULTS = { backlight: 0, brightness: 0, contrast: 0 };
var DISPLAY_STATE_FILE = require('path').join(require('os').tmpdir(), 'lglr-display-state.json');

var displayState = loadDisplayState(); // { restoreAt: ms|null, savedPicture: {...}|null }
var restoreTimer = null;

function loadDisplayState() {
    try {
        var s = JSON.parse(fs.readFileSync(DISPLAY_STATE_FILE, 'utf8'));
        return { restoreAt: s.restoreAt || null, savedPicture: s.savedPicture || null };
    } catch (_) {
        return { restoreAt: null, savedPicture: null };
    }
}

function saveDisplayState() {
    try {
        fs.writeFileSync(DISPLAY_STATE_FILE, JSON.stringify(displayState));
    } catch (e) {
        console.error('Failed to persist display state:', e && e.message ? e.message : e);
    }
}

function setDisplayMode(mode) {
    return idcapCall('idcap://system/display/mute', { displaymode: mode === 'off' ? 'screen off' : 'active' });
}

function getDisplayMode(timeoutMs) {
    return idcapCall('idcap://system/display/mute/get', {}, timeoutMs).then(function (cb) {
        var raw = cb && cb.displaymode;
        return { mode: raw === 'screen off' ? 'off' : raw === 'active' ? 'on' : raw, raw: raw };
    });
}

function displayReport(d) {
    var out = d && d.error ? { error: d.error } : { mode: d.mode, raw: d.raw };
    out.restoreAt = displayState.restoreAt ? new Date(displayState.restoreAt).toISOString() : null;
    return out;
}

// Auto-restore: on failure keep retrying, so a blank panel never depends on
// someone noticing and sending "on" by hand.
function armRestore() {
    if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
    if (!displayState.restoreAt) return;
    var delay = Math.max(0, displayState.restoreAt - Date.now());
    restoreTimer = setTimeout(function () {
        restoreTimer = null;
        setDisplayMode('on').then(function () {
            displayState.restoreAt = null;
            saveDisplayState();
        }).catch(function (err) {
            console.error('Auto-restore of display failed, retrying:', JSON.stringify(err));
            restoreTimer = setTimeout(armRestore, DISPLAY_RETRY_MS);
        });
    }, delay);
}

function cancelRestore() {
    if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
    if (displayState.restoreAt) { displayState.restoreAt = null; saveDisplayState(); }
}

function readJsonBody(req, res, cb) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
        var body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch (_) { sendJson(res, 400, { ok: false, error: 'invalid_json' }); return; }
        if (body == null || typeof body !== 'object' || Array.isArray(body)) {
            sendJson(res, 400, { ok: false, error: 'invalid_json', expected: 'JSON object' });
            return;
        }
        cb(body);
    });
}

function handleDisplayGet(res) {
    getDisplayMode().then(function (d) {
        sendJson(res, 200, { ok: true, display: displayReport(d) });
    }).catch(function (err) {
        sendJson(res, 502, { ok: false, error: 'get_display_failed', detail: err, display: displayReport({ error: err }) });
    });
}

function handleDisplayPost(req, res) {
    readJsonBody(req, res, function (body) {
        var mode = body.mode;
        if (mode !== 'off' && mode !== 'on') {
            sendJson(res, 400, { ok: false, error: 'bad_mode', expected: '{"mode":"off"|"on"}' });
            return;
        }
        var forMinutes = body.for_minutes;
        if (forMinutes != null) {
            if (mode !== 'off') {
                sendJson(res, 400, { ok: false, error: 'for_minutes_only_with_off' });
                return;
            }
            if (typeof forMinutes !== 'number' || !(forMinutes > 0) || forMinutes > MAX_FOR_MINUTES) {
                sendJson(res, 400, { ok: false, error: 'bad_for_minutes', expected: 'number > 0 and <= ' + MAX_FOR_MINUTES });
                return;
            }
        }

        if (mode === 'on') {
            // Unconditional: no state read first, so this works right after a
            // service restart whatever the panel was left in.
            cancelRestore();
            setDisplayMode('on').then(function () {
                sendJson(res, 200, { ok: true, display: displayReport({ mode: 'on', raw: 'active' }) });
            }).catch(function (err) {
                sendJson(res, 502, { ok: false, error: 'set_display_failed', requested: 'on', detail: err });
            });
            return;
        }

        setDisplayMode('off').then(function () {
            displayState.restoreAt = forMinutes != null ? Date.now() + Math.round(forMinutes * 60000) : null;
            saveDisplayState();
            armRestore();
            sendJson(res, 200, { ok: true, display: displayReport({ mode: 'off', raw: 'screen off' }) });
        }).catch(function (err) {
            sendJson(res, 502, { ok: false, error: 'set_display_failed', requested: 'off', detail: err });
        });
    });
}

function getPicture(timeoutMs) {
    return getIdcapProperties(PICTURE_KEYS, timeoutMs).then(function (props) {
        var out = {};
        PICTURE_KEYS.forEach(function (k) {
            var v = props[k];
            out[k] = (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) ? Number(v) : v;
        });
        return out;
    });
}

function pictureErrors(pic) {
    return PICTURE_KEYS.filter(function (k) { return typeof pic[k] !== 'number'; });
}

function pictureReport(p) {
    var out = p && p.error ? { error: p.error } : { values: p };
    out.preset = displayState.savedPicture ? 'night' : null;
    out.saved = displayState.savedPicture;
    return out;
}

// property/set takes the value as a string. Keys are set one at a time so a
// failure reports exactly what was and wasn't applied.
function setPicture(values) {
    var applied = {};
    return PICTURE_KEYS.filter(function (k) { return values[k] != null; }).reduce(function (p, k) {
        return p.then(function () {
            return idcapCall('idcap://configuration/property/set', { key: k, value: String(values[k]) }).then(function () {
                applied[k] = values[k];
            }, function (err) {
                throw { error: 'set_property_failed', key: k, detail: err, applied: applied };
            });
        });
    }, Promise.resolve()).then(function () { return applied; });
}

function handlePictureGet(res) {
    getPicture().then(function (p) {
        sendJson(res, 200, { ok: true, picture: pictureReport(p) });
    }).catch(function (err) {
        sendJson(res, 502, { ok: false, error: 'get_picture_failed', detail: err });
    });
}

function handlePicturePost(req, res) {
    readJsonBody(req, res, function (body) {
        var values = {};
        var bad = [];
        Object.keys(body).forEach(function (k) {
            if (k === 'preset') return;
            var v = body[k];
            if (PICTURE_KEYS.indexOf(k) === -1) bad.push(k);
            else if (typeof v !== 'number' || v !== Math.floor(v) || v < 0 || v > 100) bad.push(k);
            else values[k] = v;
        });
        if (bad.length) {
            sendJson(res, 400, { ok: false, error: 'bad_fields', fields: bad, expected: 'backlight/brightness/contrast: integers 0-100; preset: "night"|"day"' });
            return;
        }
        var preset = body.preset;
        if (preset != null && preset !== 'night' && preset !== 'day') {
            sendJson(res, 400, { ok: false, error: 'bad_preset', expected: '"night" | "day"' });
            return;
        }
        if (preset == null && !Object.keys(values).length) {
            sendJson(res, 400, { ok: false, error: 'missing_fields', example: { backlight: 20 } });
            return;
        }

        var work;
        if (preset === 'night') {
            // Snapshot only if we don't already hold one, so a second "night"
            // can't overwrite the day values with night values.
            var snapshot = displayState.savedPicture ? Promise.resolve() : getPicture().then(function (cur) {
                var missing = pictureErrors(cur);
                if (missing.length) throw { error: 'snapshot_failed', keys: missing, read: cur };
                displayState.savedPicture = cur;
                saveDisplayState();
            });
            work = snapshot.then(function () {
                return setPicture(Object.assign({}, NIGHT_DEFAULTS, values));
            });
        } else if (preset === 'day') {
            if (!displayState.savedPicture) {
                sendJson(res, 409, { ok: false, error: 'no_saved_picture', hint: 'nothing saved by "night"; set values explicitly, e.g. {"backlight":100,"brightness":50,"contrast":85}' });
                return;
            }
            work = setPicture(Object.assign({}, displayState.savedPicture, values)).then(function (applied) {
                displayState.savedPicture = null;
                saveDisplayState();
                return applied;
            });
        } else {
            work = setPicture(values);
        }

        work.then(function (applied) {
            return getPicture().catch(function (e) { return { error: e }; }).then(function (p) {
                sendJson(res, 200, { ok: true, applied: applied, picture: pictureReport(p) });
            });
        }).catch(function (err) {
            sendJson(res, 502, { ok: false, error: 'set_picture_failed', preset: preset || null, detail: err });
        });
    });
}

function normalizeSrc(s) {
    if (s == null) return null;
    var t = String(s).trim();
    if (!t || t.toLowerCase() === 'app' || t.toLowerCase() === 'status' || t.toLowerCase() === 'none') return null;
    // Accept bare "hdmi:3" / "hdmi3" / "hdmi 3" / "HDMI3" as shorthand for ext://hdmi:3
    var m = t.match(/^([a-z]+)[\s:]*(\d+)$/i);
    if (m) return 'ext://' + m[1].toLowerCase() + ':' + m[2];
    return t; // assume full ext://... URI
}

function handleViewGet(res) {
    sendJson(res, 200, { ok: true, view: state.view });
}

function handleViewPost(req, res) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
        var body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch (_) { sendJson(res, 400, { ok: false, error: 'invalid_json' }); return; }
        var src = normalizeSrc(body.src != null ? body.src : body.source);
        if (src == null) {
            state.view = null;
            sendJson(res, 200, { ok: true, view: null });
            return;
        }
        if (!/^ext:\/\/[a-z]+:\d+$/i.test(src)) {
            sendJson(res, 400, { ok: false, error: 'bad_src', expected: 'ext://hdmi:1 | ext://dp:1 | ... (or shorthand hdmi:3)' });
            return;
        }
        state.view = { src: src, setAt: new Date().toISOString() };
        sendJson(res, 200, { ok: true, view: state.view });
    });
}

function handleScreenshot(req, res) {
    // Query-string options: ?width=1920&height=1080&format=JPEG|PNG
    var params = { format: 'JPEG' };
    var q = req.url.indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?') + 1) : '';
    q.split('&').forEach(function (pair) {
        if (!pair) return;
        var kv = pair.split('=');
        var k = decodeURIComponent(kv[0]);
        var v = kv[1] ? decodeURIComponent(kv[1]) : '';
        if (k === 'width') params.width = parseInt(v, 10);
        else if (k === 'height') params.height = parseInt(v, 10);
        else if (k === 'format') params.format = v.toUpperCase();
    });

    var captureUri = null;
    idcapCall('idcap://utility/screen/capture', params).then(function (cb) {
        captureUri = cb && cb.uri;
        if (!captureUri) throw { error: 'no_uri', idcap: cb };
        // IDCAP capture saved the file; pull it back as binary via storage/file/read.
        return idcapCall('idcap://storage/file/read', { path: captureUri, encoding: 'binary' });
    }).then(function (fileRes) {
        var data = fileRes && fileRes.data;
        if (data == null) throw { error: 'no_data', path: captureUri };
        // Luna JSON serializes binary data as base64 in practice.
        var buf;
        try { buf = Buffer.from(data, 'base64'); }
        catch (e) { throw { error: 'decode_failed', cause: String(e) }; }
        if (!buf.length) throw { error: 'empty_data', path: captureUri };

        var contentType = params.format === 'PNG' ? 'image/png' : 'image/jpeg';
        state.lastCapture = { at: new Date().toISOString(), bytes: buf.length, uri: captureUri, format: params.format };
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': buf.length,
            'X-Capture-Uri': captureUri
        });
        res.end(buf);
    }).catch(function (err) {
        sendJson(res, 502, { ok: false, error: 'capture_failed', detail: err, captureUri: captureUri });
    });
}

function handleInputGet(res) {
    // Combine current + list in one response — more useful than raw /get alone.
    Promise.all([
        idcapCall('idcap://externalinput/get', {}),
        idcapCall('idcap://externalinput/inputlist/get', {}).catch(function (e) { return { _error: e }; })
    ]).then(function (results) {
        var current = results[0];
        var list = results[1];
        // Deliberately does NOT stamp state.lastInput: this is a READ. Stamping here made
        // /health's lastInput read as "last input change" when it meant "last input read",
        // which sent a debugging session down the wrong path. Only handleInputPost stamps it.
        sendJson(res, 200, {
            ok: true,
            current: { type: current.type, index: current.index },
            inputs: list && !list._error ? list.inputSourceList : null,
            currentInputPort: list && !list._error ? list.currentInputPort : null,
            count: list && !list._error ? list.count : null,
            inputListError: list && list._error ? list._error : null
        });
    }).catch(function (err) {
        sendJson(res, 502, { ok: false, error: 'get_input_failed', detail: err });
    });
}

function handleInputPost(req, res) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
        var body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch (_) { sendJson(res, 400, { ok: false, error: 'invalid_json' }); return; }

        // Accept either { type:"HDMI", index:0 } (IDCAP native) or { src:"ext://hdmi:1" } (convenience)
        var params = null;
        if (body.type && typeof body.index === 'number') {
            params = { type: String(body.type).toUpperCase(), index: body.index };
        } else if (body.src || body.source) {
            var m = String(body.src || body.source).match(/^ext:\/\/([a-z]+):(\d+)$/i);
            if (!m) { sendJson(res, 400, { ok: false, error: 'bad_src', expected: 'ext://hdmi:1 | ext://dp:1 | ext://dvi:1 | ext://ops:1' }); return; }
            var scheme = m[1].toLowerCase();
            var port = parseInt(m[2], 10);
            // Map ext:// scheme → IDCAP type enum. 1-indexed port → 0-indexed IDCAP index.
            var map = { hdmi: 'HDMI', dp: 'RGB', dvi: 'RGB', ops: 'OTHERS', rgb: 'RGB', svideo: 'SVIDEO', component: 'COMPONENT', composite: 'COMPOSITE', scart: 'SCART' };
            var type = map[scheme];
            if (!type) { sendJson(res, 400, { ok: false, error: 'unknown_src_scheme', scheme: scheme }); return; }
            params = { type: type, index: Math.max(0, port - 1) };
        } else {
            sendJson(res, 400, { ok: false, error: 'missing_input', example: { type: 'HDMI', index: 0 } });
            return;
        }

        idcapCall('idcap://externalinput/set', params).then(function () {
            state.lastInput = { at: new Date().toISOString(), type: params.type, index: params.index };
            sendJson(res, 200, { ok: true, set: params });
        }).catch(function (err) {
            sendJson(res, 502, { ok: false, error: 'set_input_failed', requested: params, detail: err });
        });
    });
}

function handleIndex(res) {
    if (INDEX_HTML == null) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html missing: ' + INDEX_HTML_ERR);
        return;
    }
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(INDEX_HTML, 'utf8'),
        'Cache-Control': 'no-cache'
    });
    res.end(INDEX_HTML);
}

// --- HTTP server ---
var server = http.createServer(function (req, res) {
    var path = req.url.split('?')[0];

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return handleIndex(res);
    if (req.method === 'GET' && path === '/health') return handleHealth(res);
    if (req.method === 'GET' && path === '/device') return handleDevice(res);
    if (req.method === 'GET' && path === '/screenshot') return handleScreenshot(req, res);
    if (req.method === 'GET' && path === '/input') return handleInputGet(res);
    if (req.method === 'POST' && path === '/input') return handleInputPost(req, res);
    if (req.method === 'GET' && path === '/view') return handleViewGet(res);
    if (req.method === 'POST' && path === '/view') return handleViewPost(req, res);
    if (req.method === 'GET' && path === '/display') return handleDisplayGet(res);
    if (req.method === 'POST' && path === '/display') return handleDisplayPost(req, res);
    if (req.method === 'GET' && path === '/picture') return handlePictureGet(res);
    if (req.method === 'POST' && path === '/picture') return handlePicturePost(req, res);

    // Dev-only self-kill so a redeploy picks up new code without a panel reboot.
    if (req.method === 'POST' && path === '/kill') {
        sendJson(res, 200, { ok: true, bye: true });
        setTimeout(function () { process.exit(0); }, 200);
        return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found', path: req.url });
});

server.on('error', function (err) {
    state.listenError = err && err.message ? err.message : String(err);
    console.error('HTTP server error:', state.listenError);
});

server.listen(HTTP_PORT, '0.0.0.0', function () {
    console.log('LG Local Remote HTTP API listening on 0.0.0.0:' + HTTP_PORT);
});

// Resume a pending auto-restore after a service restart (fires at once if the
// deadline has already passed).
armRestore();
