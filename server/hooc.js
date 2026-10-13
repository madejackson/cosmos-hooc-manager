'use strict';
// HOOC Connect manager engine: install/load image, run container, status, watchdog.
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const docker = require('./docker');

const CONTAINER = 'hooc-connect';
const DEFAULT_DATA = process.env.HOOC_DATA_DIR || (process.env.DATA_DIR || path.join(os.tmpdir(), 'hooc-manager'));
const IMAGE_STORE = path.join(DEFAULT_DATA, 'images');   // downloaded .tar files kept here
const BACKUP_DIR = path.join(DEFAULT_DATA, 'backup');     // docker-save backups (like /opt/docker/cosmos/hooc)
const STATE_FILE = path.join(DEFAULT_DATA, 'state.json');
const WATCHDOG_INTERVAL = parseInt(process.env.WATCHDOG_INTERVAL || '30', 10);

// Original HOOC tool: name "hooc-connect", command mirrors the docs:
//   docker run --name hooc-connect --detach --device /dev/net/tun \
//     --cap-add NET_ADMIN --cap-add NET_BIND_SERVICE --network host \
//     --restart unless-stopped hooc/connect-<serial>:<ver> [--vpn.linux.bridge=...]
const dockerRunArgs = (image, bridge) => {
  const spec = {
    Image: image,
    Cmd: bridge ? [`--vpn.linux.bridge=${bridge}`] : [],
    HostConfig: {
      NetworkMode: 'host',
      CapAdd: ['NET_ADMIN', 'NET_BIND_SERVICE'],
      RestartPolicy: { Name: 'unless-stopped' },
    },
    Env: ['HOOC_DOCKER_ENV=1'],
  };
  // optional device for /dev/net/tun — only add if the host has it
  if (fs.existsSync('/dev/net/tun')) {
    spec.HostConfig.Devices = [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }];
  }
  return spec;
};

function fileExists(p) { try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- download helper (supports https & http, follows redirects) ----------
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const out = fs.createWriteStream(dest);
    const req = mod.get(url, { headers: { 'User-Agent': 'cosmos-hooc-manager/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        out.close();
        fs.unlink(dest, () => {});
        return download(new URL(res.headers.location, url).toString(), dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`download ${url}: HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', (c) => { received += c.length; if (onProgress) onProgress(received, total); });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
    });
    req.on('error', (e) => { out.destroy(); reject(e); });
  });
}

function parseWgetUrl(input) {
  // Accept: 1) full wget command  2) plain URL
  let url = input.trim();
  if (/^wget\b/.test(url)) {
    const m = url.match(/https?:\/\/\S+/);
    if (!m) throw new Error('wget command contains no URL');
    url = m[0].replace(/["']+$/, '');
  }
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('unsupported protocol');
  return { url, filename: path.basename(u.pathname) || `hooc-image-${Date.now()}.tar` };
}

async function loadTar(file) {
  const res = await docker.loadImageFromTarStream(fs.createReadStream(file));
  const m = res.body.match(/Loaded image: (\S+)/);
  if (!m) throw new Error('docker load did not report an image: ' + res.body.slice(0, 300));
  return m[1];
}

// ---------- status ----------
async function status() {
  const state = readState();
  const info = { container: null, image: null, imageActivated: false, serial: state.serial || null, hwid: state.hwid || null, vpn: 'unknown', lastLog: '', uptime: null, error: null };
  const all = await docker.listContainers(true);
  const me = all.find(c => (c.Names || []).includes('/' + CONTAINER));
  if (me) {
    const d = await docker.getContainer(me.Id);
    info.container = {
      id: me.Id.slice(0, 12), state: me.State, status: me.Status,
      image: me.Image, created: me.Created,
    };
    if (d && d.State) {
      info.uptime = d.State.StartedAt || null;
      info.restartCount = d.RestartCount || 0;
    }
    if (me.State === 'running') {
      try { info.lastLog = (await docker.logs(me.Id, 120)).slice(-4000); } catch {}
      const connected = /Successfully connected to VPN/i.test(info.lastLog);
      const err = /level=fatal|level=error/i.test(info.lastLog);
      info.vpn = connected ? 'connected' : (err ? 'error' : 'connecting');
    } else {
      info.vpn = 'stopped';
    }
  }
  const images = await docker.listImages();
  const hoocImgs = images.filter(i => (i.RepoTags || []).some(t => /hooc\/connect/.test(t)));
  info.images = hoocImgs.map(i => ({ tags: i.RepoTags, id: i.Id.slice(7, 19), size: i.Size, created: i.Created }));
  if (hoocImgs.length) {
    const tag = hoocImgs[0].RepoTags[0];
    info.image = tag;
    info.imageActivated = /hooc\/connect-\d{20}/.test(tag);
  }
  // hwid from state or from image name
  if (!info.hwid && info.imageActivated) {
    const m = info.image.match(/connect-(\d{20})/);
    info.serial = m ? m[1] : info.serial;
  }
  return info;
}

// ---------- install ----------
async function installWget(input, { bridge, onLog } = {}) {
  const log = (m) => { if (onLog) onLog(m); else console.log(m); };
  const { url, filename } = parseWgetUrl(input);
  log('Downloading HOOC image...');
  fs.mkdirSync(IMAGE_STORE, { recursive: true });
  const dest = path.join(IMAGE_STORE, filename);
  await download(url, dest, (got, total) => {
    const pct = total ? `${Math.round(got / total * 100)}%` : `${Math.round(got / 1048576)}MB`;
    log(`download ${pct} (${Math.round(got / 1048576)}MB)`);
  });
  log(`Loaded ${dest}`);
  const image = await loadTar(dest);
  log(`Loaded image: ${image}`);
  // remember the tar as backup
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(dest, path.join(BACKUP_DIR, path.basename(dest)));
  } catch (e) { log('backup copy: ' + e.message); }
  // save state
  const st = readState();
  const serial = (image.match(/connect-(\d{20})/) || [])[1] || null;
  st.image = image; if (serial) st.serial = serial;
  writeState(st);
  await run(image, { bridge, onLog: log });
  return image;
}

async function run(image, { bridge, onLog } = {}) {
  const log = (m) => { if (onLog) onLog(m); else console.log(m); };
  const all = await docker.listContainers(true);
  const existing = all.find(c => (c.Names || []).includes('/' + CONTAINER));
  if (existing) {
    log('Stopping existing hooc-connect...');
    await docker.stopContainer(existing.Id).catch(() => {});
    await docker.removeContainer(existing.Id).catch(() => {});
  }
  log('Starting hooc-connect...');
  const spec = dockerRunArgs(image, bridge);
  const created = await docker.createContainer(CONTAINER, spec);
  await docker.startContainer(created.Id);
  log('Started container ' + created.Id.slice(0, 12));
  const st = readState(); st.image = image; writeState(st);
  return created.Id;
}

// hwid: run the image in --rm with the hwid command. This produces the hwid
// string in the logs (only works on hosts where hwid generation succeeds, i.e.
// with real NIC MACs like on the OpenWrt box).
async function computeHwid(image) {
  const spec = {
    Image: image,
    Cmd: ['hwid'],
    HostConfig: { NetworkMode: 'host', CapAdd: ['NET_ADMIN', 'NET_BIND_SERVICE'], AutoRemove: true },
    Env: ['HOOC_DOCKER_ENV=1'],
    Tty: true,
  };
  const name = 'hooc-hwid-' + crypto.randomBytes(3).toString('hex');
  const c = await docker.createContainer(name, spec);
  await docker.startContainer(c.Id);
  for (let i = 0; i < 30; i++) { await sleep(500); const d = await docker.getContainer(c.Id); if (!d || !d.State.Running) break; }
  let out = '';
  try { out = await docker.logs(c.Id, 20); } catch {}
  const m = out.match(/([0-9a-f]{64})/);
  return m ? m[1] : null;
}

// ---------- watchdog ----------
async function watchdogTick() {
  const allC = await docker.listContainers(true);
  const running = await docker.listContainers(false);
  const has = allC.some(c => (c.Names || []).includes('/' + CONTAINER));
  const isRun = running.some(c => (c.Names || []).includes('/' + CONTAINER));
  if (isRun) return 'ok';
  const images = await docker.listImages();
  const anyHooc = images.some(i => (i.RepoTags || []).some(t => /hooc\/connect/.test(t)));
  if (!has) {
    // container deleted -> recreate from image if available
    if (anyHooc) { await recreate(); return 'recreated'; }
    return 'no-image';
  }
  // exists but stopped -> start
  const me = allC.find(c => (c.Names || []).includes('/' + CONTAINER));
  await docker.startContainer(me.Id).catch(() => {});
  return 'restarted';
}

async function recreate() {
  const images = await docker.listImages();
  const hooc = images.filter(i => (i.RepoTags || []).some(t => /hooc\/connect/.test(t)));
  if (!hooc.length) return;
  // prefer activated image
  const activated = hooc.find(i => (i.RepoTags || []).some(t => /hooc\/connect-\d{20}/.test(t)));
  const img = activated || hooc[0];
  const st = readState();
  await run(img.RepoTags[0], { bridge: st.bridge });
}

function startWatchdog(onEvent) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try { const r = await watchdogTick(); if (r !== 'ok' && onEvent) onEvent(r); }
      catch (e) { if (onEvent) onEvent('error:' + e.message); }
      await sleep(WATCHDOG_INTERVAL * 1000);
    }
  })();
  return () => { stopped = true; };
}

// ---------- state ----------
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

module.exports = { CONTAINER, installWget, run, status, computeHwid, watchdogTick, startWatchdog, readState, writeState, parseWgetUrl, download, loadTar, DEFAULT_DATA };
