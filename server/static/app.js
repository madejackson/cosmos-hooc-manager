'use strict';
const $ = (id) => document.getElementById(id);
let state = null;
let theme = localStorage.getItem('hooc-theme') || 'dark';

function setPill(id, cls, txt) { const el = $(id); el.className = 'pill' + (cls ? ' ' + cls : ''); el.textContent = txt; }

async function api(path, opts) {
  const r = await fetch(path, opts);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error((j && j.error) || t || r.statusText);
  return j;
}

async function loadStatus() {
  try {
    state = await api('/api/status');
    render();
  } catch (e) {
    setPill('vpn-pill', 'bad', 'API-Fehler');
  }
}

function render() {
  const s = state || {};
  // container
  const c = s.container;
  setPill('vpn-pill',
    s.vpn === 'connected' ? 'ok' : (s.vpn === 'connecting' ? 'warn' : 'bad'),
    s.vpn ? s.vpn.toUpperCase() : '—');
  $('st-container').textContent = c ? `${c.state} (${c.status || ''})`.trim() : '—';
  $('st-vpn').textContent = s.vpn || '—';
  $('st-image').textContent = s.image || '—';
  $('st-hwid').textContent = s.hwid || '—';
  $('st-activated').textContent = s.imageActivated ? 'Ja (mit VPN-Zugang)' : (s.image ? 'Nein (generisch)' : '—');
  $('st-uptime').textContent = s.uptime ? new Date(s.uptime).toLocaleString() : '—';
  // task
  if (s.task && s.task.status === 'installing') {
    $('install-log').hidden = false;
    $('install-log').textContent = (s.task.logs || []).join('\n');
    $('btn-install').disabled = true;
  } else if (s.task && (s.task.status === 'done' || s.task.status === 'error')) {
    $('install-log').hidden = false;
    $('install-log').textContent = (s.task.logs || []).join('\n');
    $('btn-install').disabled = false;
  } else {
    $('btn-install').disabled = false;
  }
  // watchdog
  if (typeof s.watchdogEnabled === 'boolean') $('watchdog-toggle').checked = s.watchdogEnabled;
  // events
  const evs = s.events || [];
  const box = $('events');
  box.innerHTML = evs.map(e => `<div class="ev">${e.t} — ${e.ev}</div>`).join('') || '<div class="ev">noch keine Ereignisse</div>';
  // log
  if (s.container && s.container.state === 'running') {
    $('container-log').textContent = s.lastLog || '(keine Logs)';
  } else {
    $('container-log').textContent = '(Container nicht gestartet)';
  }
}

async function action(url, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  try { await api(url, { method: 'POST' }); await loadStatus(); }
  catch (e) { alert('Fehler: ' + e.message); }
}

async function install() {
  const wget = $('wget-input').value.trim();
  const bridge = $('bridge-input').value.trim();
  if (!wget) { alert('Bitte wget-Link einfügen'); return; }
  try {
    await api('/api/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wget, bridge }) });
    $('install-log').hidden = false;
    $('install-log').textContent = 'Installiere...';
    // poll
    const t = setInterval(async () => {
      try { const s = await api('/api/status'); state = s; render();
        if (s.task && (s.task.status === 'done' || s.task.status === 'error')) { clearInterval(t); loadStatus(); }
      } catch {}
    }, 1500);
  } catch (e) { alert('Fehler: ' + e.message); }
}

async function toggleWatchdog() {
  const on = $('watchdog-toggle').checked;
  try { const r = await api('/api/watchdog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enable: on }) }); state.watchdogEnabled = r.enabled; render(); }
  catch (e) { alert(e.message); loadStatus(); }
}

document.addEventListener('DOMContentLoaded', () => {
  $('refresh-btn').onclick = loadStatus;
  $('btn-install').onclick = install;
  $('btn-start').onclick = () => action('/api/start');
  $('btn-restart').onclick = () => action('/api/restart');
  $('btn-stop').onclick = () => action('/api/stop', 'Container wirklich stoppen?');
  $('btn-uninstall').onclick = () => action('/api/uninstall', 'HOOC Connect wirklich deinstallieren (Container entfernen)?');
  $('watchdog-toggle').onchange = toggleWatchdog;
  $('theme-toggle').onclick = () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('hooc-theme', theme); } catch {}
  };
  loadStatus();
  setInterval(loadStatus, 5000);
});
