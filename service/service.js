'use strict';

// webos-service is provided by the device runtime (not npm); this service only
// runs on-device. Running `node service.js` on the host fails at this require.
var Service = require('webos-service');
var IDCAP = require('./idcap.js');
var http = require('http');

var SERVICE_NAME = 'com.lg.app.signage.dev.remote';
var HTTP_PORT = 9999;
var VERSION = '0.0.1';
var IDCAP_TIMEOUT_MS = 15000;

var service = new Service(SERVICE_NAME);
var idcap = new IDCAP(service);

var state = {
    startedAt: Date.now(),
    httpPort: HTTP_PORT,
    listenError: null,
    lastCapture: null,    // { at, bytes } | null
    lastInput: null       // { at, type, index } | null
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
        lastInput: state.lastInput
    });
});

// --- IDCAP helpers: promise with timeout + uniform error shape ---
function idcapCall(uri, params) {
    return new Promise(function (resolve, reject) {
        var settled = false;
        var to = setTimeout(function () {
            if (!settled) { settled = true; reject({ error: 'idcap_timeout', uri: uri, timeoutMs: IDCAP_TIMEOUT_MS }); }
        }, IDCAP_TIMEOUT_MS);
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

// --- endpoint handlers ---
function handleHealth(res) {
    sendJson(res, 200, {
        ok: true,
        service: SERVICE_NAME,
        version: VERSION,
        uptimeSeconds: uptimeSeconds(),
        httpReady: state.listenError == null,
        lastCapture: state.lastCapture,
        lastInput: state.lastInput
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
        state.lastInput = { at: new Date().toISOString(), type: current.type, index: current.index };
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

// --- HTTP server ---
var server = http.createServer(function (req, res) {
    var path = req.url.split('?')[0];

    if (req.method === 'GET' && path === '/health') return handleHealth(res);
    if (req.method === 'GET' && path === '/screenshot') return handleScreenshot(req, res);
    if (req.method === 'GET' && path === '/input') return handleInputGet(res);
    if (req.method === 'POST' && path === '/input') return handleInputPost(req, res);

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
