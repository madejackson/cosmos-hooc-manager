'use strict';
// Minimal Docker Engine API client over the unix socket (no deps).
const http = require('http');
const fs = require('fs');
const path = require('path');

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

function request(method, urlPath, { body, headers, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path: urlPath, method, headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    if (rawBody) {
      // stream body: let the pipe finish and end the request automatically.
      rawBody.on('end', () => req.end());
      rawBody.on('error', reject);
      rawBody.pipe(req);
    } else {
      req.end();
    }
  });
}

async function json(method, urlPath, body) {
  const res = await request(method, urlPath, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });
  let data = null;
  const text = res.body.toString('utf8');
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (res.status >= 400) {
    const err = new Error(`docker ${method} ${urlPath} -> ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status; err.data = data; throw err;
  }
  return data;
}

function listContainers(all = true) {
  return json('GET', `/containers/json?all=${all ? 1 : 0}`);
}
async function getContainer(idOrName) {
  try { return await json('GET', `/containers/${encodeURIComponent(idOrName)}/json`); }
  catch { return null; }
}
function startContainer(id) { return request('POST', `/containers/${encodeURIComponent(id)}/start`).then(r => ({ status: r.status })); }
function stopContainer(id, timeout = 10) { return request('POST', `/containers/${encodeURIComponent(id)}/stop?t=${timeout}`).then(r => ({ status: r.status })); }
function restartContainer(id, timeout = 10) { return request('POST', `/containers/${encodeURIComponent(id)}/restart?t=${timeout}`).then(r => ({ status: r.status })); }
function removeContainer(id, force = true) { return request('DELETE', `/containers/${encodeURIComponent(id)}?force=${force}`).then(r => ({ status: r.status })); }

async function logs(id, tail = 200) {
  const res = await request('GET', `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${tail}`);
  // Docker log stream: 8-byte header per frame (stream,size) then payload
  const buf = res.body;
  let out = '';
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off + 4);
    const start = off + 8;
    const end = Math.min(start + size, buf.length);
    out += buf.toString('utf8', start, end);
    off = end;
  }
  return out;
}

function listImages() { return json('GET', '/images/json'); }

function loadImageFromTarStream(tarStream) {
  return request('POST', '/images/load', { rawBody: tarStream, headers: { 'Content-Type': 'application/x-tar' } })
    .then(res => ({ status: res.status, body: res.body.toString('utf8') }));
}

function createContainer(name, spec) {
  return json('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec);
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = {
  SOCKET, request, json, listContainers, getContainer, startContainer,
  stopContainer, restartContainer, removeContainer, logs, listImages,
  loadImageFromTarStream, createContainer, readStream,
  socketAvailable: () => fs.existsSync(SOCKET),
};
