'use strict';
// cosmos-hooc-manager — HTTP API + static UI + HOOC embedded WebUI proxy
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const hooc = require('./hooc');
const docker = require('./docker');

const PORT = parseInt(process.env.PORT || '8095', 10);
const HOST = process.env.HOST || '0.0.0.0';
const HOOC_API_PORT = parseInt(process.env.HOOC_API_PORT || '1323', 10);
const STATIC = path.join(__dirname, 'static');
const dockerSockOk = docker.socketAvailable();

let currentTask = null; // {type, logs[], status}
let watchdogStop = null;
let lastEvents = [];

function api(statusCode, res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, pathname) {
  let p = path.normalize(path.join(STATIC, pathname));
  if (!p.startsWith(STATIC)) { res.writeHead(403); return res.end('forbidden'); }
  if (fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(p);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(p).pipe(res);
}

// Proxy to the HOOC app's embedded web UI (127.0.0.1:1323 after we started it,
// or the hooc-connect container's own port). The HOOC web UI is the "BAB-style"
// local manager (status + activation). We mount it under /hooc/ so users get the
// full native experience without a second route.
function proxyToHooc(req, res, targetPort) {
  const options = { hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } };
  const proxy = http.request(options, (pRes) => {
    res.writeHead(pRes.statusCode || 502, pRes.headers);
    pRes.pipe(res);
  });
  proxy.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('hooc api unreachable: ' + e.message); });
  req.pipe(proxy);
}

function ensureTask() {
  if (!currentTask) currentTask = { type: 'idle', logs: [], status: 'idle' };
  return currentTask;
}
function taskLog(msg) { const t = ensureTask(); t.logs.push(`${new Date().toISOString()} ${msg}`); if (t.logs.length > 500) t.logs = t.logs.slice(-500); }

async function startInstaller(wgetUrl, bridge) {
  if (currentTask && (currentTask.status === 'running' || currentTask.status === 'installing')) {
    throw new Error('a task is already running');
  }
  currentTask = { type: 'install', logs: ['starting install...'], status: 'installing' };
  const log = (m) => { taskLog(m); if (m.match(/download (\d+%)/)) currentTask.progress = m; };
  (async () => {
    try {
      await hooc.installWget(wgetUrl, { bridge, onLog: log });
      currentTask.status = 'done';
      taskLog('install complete');
    } catch (e) {
      currentTask.status = 'error';
      taskLog('ERROR: ' + e.message);
    }
  })();
  return true;
}

function handleApi(req, res, url) {
  const route = url.pathname;
  if (req.method === 'GET' && route === '/api/status') {
    hooc.status().then(s => {
      s.dockerSocket = dockerSockOk;
      s.task = currentTask ? { type: currentTask.type, status: currentTask.status, logs: currentTask.logs.slice(-30), progress: currentTask.progress } : null;
      s.events = lastEvents.slice(-10);
      s.hoocWeb = { port: HOOC_API_PORT, proxyPath: '/hooc/' };
      api(200, res, s);
    }).catch(e => api(500, res, { error: e.message }));
    return true;
  }
  if (req.method === 'POST' && route === '/api/install') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body); } catch {}
      if (!p.wget) return api(400, res, { error: 'wget link required' });
      startInstaller(p.wget, p.bridge || '').then(() => api(202, res, { ok: true })).catch(e => api(409, res, { error: e.message }));
    });
    return true;
  }
  if (req.method === 'POST' && route === '/api/hwid') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let p = {};
      try { p = JSON.parse(body); } catch {}
      try {
        const images = await docker.listImages();
        const hoocImgs = images.filter(i => (i.RepoTags || []).some(t => /hooc\/connect/.test(t)));
        if (!hoocImgs.length) return api(400, res, { error: 'no hooc image installed' });
        const img = (p.image) || hoocImgs[0].RepoTags[0];
        taskLog('computing hwid...');
        const hwid = await hooc.computeHwid(img);
        if (!hwid) return api(500, res, { error: 'could not derive hwid (need NET_ADMIN/machine-id on host)' });
        const st = hooc.readState(); st.hwid = hwid; hooc.writeState(st);
        api(200, res, { hwid });
      } catch (e) { api(500, res, { error: e.message }); }
    });
    return true;
  }
  if (req.method === 'POST' && (route === '/api/start' || route === '/api/stop' || route === '/api/restart')) {
    (async () => {
      const all = await docker.listContainers(true);
      const me = all.find(c => (c.Names || []).includes('/' + hooc.CONTAINER));
      if (!me) return api(404, res, { error: 'hooc-connect not installed' });
      if (route === '/api/start') { await docker.startContainer(me.Id); }
      if (route === '/api/stop') { await docker.stopContainer(me.Id); }
      if (route === '/api/restart') { await docker.restartContainer(me.Id); }
      api(200, res, { ok: true });
    })().catch(e => api(500, res, { error: e.message }));
    return true;
  }
  if (req.method === 'POST' && route === '/api/watchdog') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p = {}; try { p = JSON.parse(body); } catch {}
      if (p.enable && !watchdogStop) {
        watchdogStop = hooc.startWatchdog((ev) => { lastEvents.push({ t: new Date().toISOString(), ev }); });
      } else if (!p.enable && watchdogStop) { watchdogStop(); watchdogStop = null; }
      api(200, res, { enabled: !!watchdogStop });
    });
    return true;
  }
  if (req.method === 'DELETE' && route === '/api/uninstall') {
    (async () => {
      const all = await docker.listContainers(true);
      const me = all.find(c => (c.Names || []).includes('/' + hooc.CONTAINER));
      if (me) { await docker.stopContainer(me.Id).catch(() => {}); await docker.removeContainer(me.Id); }
      // also remove images? just leave them; user can prune
      api(200, res, { ok: true });
    })().catch(e => api(500, res, { error: e.message }));
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (handleApi(req, res, url)) return;
      api(404, res, { error: 'unknown api' });
      return;
    }
    if (url.pathname === '/hooc/' || url.pathname.startsWith('/hooc/')) {
      // proxy to embedded HOOC web UI
      url.pathname = url.pathname.slice('/hooc'.length) || '/';
      const target = new URL(req.url, 'http://x');
      target.pathname = url.pathname;
      target.search = url.search;
      proxyToHooc(req, res, HOOC_API_PORT);
      return;
    }
    serveStatic(res, url.pathname === '/' ? '/index.html' : url.pathname);
  } catch (e) {
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('error: ' + e.message); }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`cosmos-hooc-manager listening on http://${HOST}:${PORT}`);
  console.log(`docker socket: ${dockerSockOk ? 'available' : 'NOT available'}`);
});
