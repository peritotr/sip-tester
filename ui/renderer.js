// Connection form, registration, single-test view (calls + SIP log).
// window.api is provided by preload.js (desktop) or web-api.js (browser).
const $ = id => document.getElementById(id);
const t = (s, p) => I18N.t(s, p);
const tm = o => I18N.msg(o);
const CONN_FIELDS = ['host','port','transport','domain','user','password','authUser','displayName','localPort','rtpPort','contactIp','expires','timeout','t1'];
const CALL_FIELDS = ['dst','duration','rtp','codec','count','cps'];
const val = id => { const e = $(id); return e.type === 'checkbox' ? e.checked : e.value; };
const setVal = (id, v) => { const e = $(id); if (!e || v === undefined) return; if (e.type === 'checkbox') e.checked = !!v; else e.value = v; };
const time = ts => new Date(ts).toLocaleTimeString(I18N.locale, { hour12: false }) + '.' + String(ts % 1000).padStart(3, '0');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n1 = v => v == null ? '—' : (v < 10 ? v.toFixed(1) : Math.round(v).toString());

let state = 'disconnected', stateInfo = null, profiles = [], reg = { state: 'none' };

// ---------- Language ----------
setVal('lang', I18N.lang);
$('lang').onchange = () => I18N.setLang(val('lang'));
I18N.apply();

// ---------- Persisted form ----------
function saveForm() {
  const o = {}; [...CONN_FIELDS, ...CALL_FIELDS].forEach(f => o[f] = f === 'password' ? undefined : val(f));
  try { localStorage.setItem('form', JSON.stringify(o)); } catch {}
}
try { const o = JSON.parse(localStorage.getItem('form') || '{}'); for (const k in o) setVal(k, o[k]); } catch {}
document.addEventListener('change', saveForm);
const connCfg = () => { const c = {}; CONN_FIELDS.forEach(f => c[f] = typeof val(f) === 'string' ? val(f).trim() : val(f)); return c; };

// ---------- Profiles ----------
async function refreshProfiles(sel) {
  profiles = await api.loadProfiles();
  $('profile').innerHTML = `<option value="">${esc(t('— Profile —'))}</option>` + profiles.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  if (sel != null) $('profile').value = sel;
}
$('profile').onchange = () => { const p = profiles[$('profile').value]; if (!p) return; CONN_FIELDS.forEach(f => setVal(f, p[f])); saveForm(); };
$('saveProfile').onclick = () => {
  const cur = profiles[$('profile').value];
  $('nameRow').style.display = '';
  setVal('profileName', cur ? cur.name : `${val('user') || 'sip'}@${val('host')}`);
  $('profileName').select();
};
$('nameCancel').onclick = () => { $('nameRow').style.display = 'none'; };
$('profileName').onkeydown = e => { if (e.key === 'Enter') $('nameOk').click(); if (e.key === 'Escape') $('nameCancel').click(); };
$('nameOk').onclick = async () => {
  const name = val('profileName').trim(); if (!name) return;
  $('nameRow').style.display = 'none';
  const p = { name, ...connCfg() };
  const idx = profiles.findIndex(x => x.name === name);
  if (idx >= 0) profiles[idx] = p; else profiles.push(p);
  await api.saveProfiles(profiles);
  await refreshProfiles(profiles.findIndex(x => x.name === name));
};
$('delProfile').onclick = async () => {
  const i = $('profile').value; if (i === '') return;
  if (!confirm(t('Delete "{name}"?', { name: profiles[i].name }))) return;
  profiles.splice(i, 1); await api.saveProfiles(profiles); await refreshProfiles();
};
$('transport').onchange = () => { if (val('transport') === 'tcp' && val('port') === '') setVal('port', 5060); };

// ---------- Connection ----------
$('connect').onclick = async () => {
  if (!val('host').trim()) { $('host').focus(); return; }
  const r = await api.connect(connCfg());
  if (r && !r.ok) alert(tm(r.error));
};
$('disconnect').onclick = () => api.disconnect();
$('ping').onclick = async () => {
  $('pingRes').textContent = 'OPTIONS…'; $('pingRes').className = 'small mono muted';
  const r = await api.options();
  if (r && r.error) { $('pingRes').textContent = tm(r.error); $('pingRes').className = 'small mono err'; return; }
  $('pingRes').textContent = r.status ? `OPTIONS → ${r.status} ${r.reason || ''} · ${n1(r.ms)} ms` : t('OPTIONS: no response (timeout)');
  $('pingRes').className = 'small mono ' + (r.ok ? 'ok' : 'err');
};

const STATE_TXT = { disconnected: 'disconnected', connecting: 'connecting…', ready: 'connected', error: 'error' };
function renderState() {
  const info = stateInfo ? tm(stateInfo) : '';
  const registered = state === 'ready' && reg.state === 'registered';
  $('stateDot').className = 'dot ' + (registered ? 'registered' : state);
  $('stateText').textContent = t(STATE_TXT[state] || state) + (registered ? ' · ' + t('registered') : '') + (info ? ' · ' + info : '');
  $('stateText').title = $('stateText').textContent;
}
api.on('sip:state', s => {
  state = s.state;
  stateInfo = s.state === 'ready' ? { key: '{transport} · local {local}', p: { transport: s.transport, local: s.local } } : (s.key ? { key: s.key, p: s.p } : s.text ? s.text : null);
  renderState(); updateButtons();
});
function updateButtons() {
  const busy = state === 'connecting' || state === 'ready';
  $('connect').disabled = busy; $('disconnect').disabled = !busy;
  $('ping').disabled = state !== 'ready';
  $('register').disabled = state !== 'ready' || reg.state === 'registering';
  $('unregister').disabled = state !== 'ready' || reg.state !== 'registered';
  $('call').disabled = state !== 'ready';
  $('hangupAll').disabled = state !== 'ready' || !activeCalls();
}

// ---------- Registration ----------
$('register').onclick = async () => { const r = await api.register(); if (r && r.error) alert(tm(r.error)); };
$('unregister').onclick = () => api.register(0);
function renderReg() {
  const e = $('regState');
  const tail = reg.status ? ` · ${reg.status} ${reg.reason || ''}${reg.ms != null ? ' · ' + n1(reg.ms) + ' ms' : ''}` : '';
  if (reg.state === 'registered') { e.textContent = t('Registered for {s} s (refreshed automatically)', { s: reg.expires }) + tail; e.className = 'small ok'; }
  else if (reg.state === 'registering' || reg.state === 'unregistering') { e.textContent = t(reg.state === 'registering' ? 'Registering…' : 'Unregistering…'); e.className = 'small muted'; }
  else if (reg.state === 'failed') { e.textContent = t('Registration failed') + (reg.status ? tail : reg.reason ? ' · ' + tm(reg.reason) : ' · ' + t('no response (timeout)')); e.className = 'small err'; }
  else { e.textContent = t('Not registered') + tail; e.className = 'small muted'; }
}
api.on('sip:reg', r => { reg = r; renderReg(); renderState(); updateButtons(); });

// ---------- Calls ----------
const calls = new Map(); // id → row
let selCall = null;
$('call').onclick = async () => {
  if (!val('dst').trim()) { $('dst').focus(); return; }
  const m = {}; CALL_FIELDS.forEach(f => m[f] = val(f));
  const r = await api.call(m);
  if (r && !r.ok) alert(tm(r.error));
};
$('hangupAll').onclick = () => api.hangupAll();
const activeCalls = () => [...calls.values()].filter(c => c.state !== 'ended').length;
const END_TXT = { bye: 'hung up (BYE)', remoteBye: 'hung up by the server', failed: 'failed', timeout: 'no response', noanswer: 'no answer (cancelled)', cancelled: 'cancelled',
  byeFailed: 'BYE failed', byeTimeout: 'BYE: no response', cancelTimeout: 'CANCEL: no response', disconnected: 'disconnected' };
function stClass(c) { return c.state === 'ended' ? (c.end === 'bye' || c.end === 'remoteBye' ? 'st-answered' : 'st-failed') : 'st-' + c.state; }
function callRow(c) {
  const r = c.rtp;
  const loss = r && r.expected ? (r.lossPct < 0.01 && r.lossPct > 0 ? '<0.01' : r.lossPct.toFixed(2)) + '%' : '—';
  return `<td>${c.id}</td><td>${time(c.ts)}</td><td>${esc(c.dst)}</td><td class="${stClass(c)}">${esc(c.status || t(c.state))}</td>
    <td>${n1(c.t100)}</td><td>${n1(c.pdd)}</td><td>${n1(c.ans)}</td><td>${c.dur != null ? c.dur.toFixed(1) + ' s' : '—'}</td>
    <td class="txt">${c.state === 'ended' ? esc(t(END_TXT[c.end] || c.end || '')) + (c.bye && c.end !== 'bye' ? ' · ' + esc(c.bye) : '') : ''}</td>
    <td>${r ? `${r.tx} / ${r.rx}` : c.rtpOn ? '…' : '—'}</td><td>${loss}</td><td>${r && r.rx > 10 ? n1(r.jitter) + ' ms' : '—'}</td><td>${r && r.rtt != null ? n1(r.rtt) + ' ms' : '—'}</td>
    <td>${c.state !== 'ended' ? `<button class="ghost" data-hangup="${c.id}">${esc(t('Hang up'))}</button>` : ''}</td>`;
}
api.on('sip:call', c => {
  const isNew = !calls.has(c.id);
  calls.set(c.id, c);
  let tr = document.querySelector(`#callBody tr[data-id="${c.id}"]`);
  if (!tr) { tr = document.createElement('tr'); tr.dataset.id = c.id; $('callBody').prepend(tr); }
  tr.innerHTML = callRow(c); tr.classList.toggle('sel', selCall === c.callId);
  if (isNew) { $('cCalls').textContent = calls.size; $('callHint').style.display = 'none'; }
  updateButtons();
});
api.on('sip:batch', b => { $('progress').textContent = b.running ? t('Calling…') : ''; });
$('callBody').onclick = e => {
  const h = e.target.dataset && e.target.dataset.hangup;
  if (h) { api.hangup(Number(h)); return; }
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const c = calls.get(Number(tr.dataset.id)); if (!c) return;
  selCall = c.callId;
  document.querySelectorAll('#callBody tr').forEach(x => x.classList.toggle('sel', x === tr));
  showTab('log'); renderLog();
};

// ---------- SIP log ----------
let logs = [];
api.on('sip:log', list => {
  for (const e of list) logs.push(e);
  if (logs.length > 5000) logs = logs.slice(-4000);
  $('cLog').textContent = logs.length;
  if ($('pane-log').classList.contains('on')) renderLog(true);
});
function logVisible(e) {
  if (selCall && e.callId !== selCall) return false;
  if (val('hideOptions') && !selCall && / OPTIONS$|^OPTIONS /.test(e.first + ' ' + cseqM(e))) return false;
  return true;
}
const cseqM = e => { const r = /\r\nCSeq:\s*\d+\s+(\w+)/i.exec(e.text || ''); return r ? r[1] : ''; };
function logLine(e) {
  const status = /^SIP\/2.0 (\d)/.exec(e.first), cls = status ? 'resp' + status[1] : '';
  const arrow = e.dir === 'out' ? '→' : e.dir === 'in' ? '←' : '•';
  const extra = status ? ` <span class="r">(${esc(cseqM(e))})</span>` : '';
  return `<div class="le"><span class="t">${time(e.ts)}</span><span class="d ${e.dir}">${arrow}</span><span class="c ${cls}">${esc(e.first)}</span>${extra}<span class="r">${esc(e.remote || '')}</span><pre>${esc(e.text)}</pre></div>`;
}
let renderQueued = false;
function renderLog(throttled) {
  if (throttled) { if (renderQueued) return; renderQueued = true; return setTimeout(() => { renderQueued = false; renderLog(); }, 150); }
  const vis = logs.filter(logVisible).slice(-1500);
  $('logList').innerHTML = vis.map(logLine).join('');
  $('logFilter').style.display = selCall ? '' : 'none';
}
$('logList').onclick = e => { const le = e.target.closest('.le'); if (le && !window.getSelection().toString()) le.classList.toggle('open'); };
$('clearFilter').onclick = () => { selCall = null; document.querySelectorAll('#callBody tr').forEach(x => x.classList.remove('sel')); renderLog(); };
$('hideOptions').onchange = () => renderLog();
$('clear').onclick = () => { logs = []; calls.clear(); selCall = null; $('callBody').innerHTML = ''; $('logList').innerHTML = ''; $('cLog').textContent = '0'; $('cCalls').textContent = '0'; updateButtons(); };
$('exportLog').onclick = () => api.exportLog(logs.filter(logVisible).map(e => `${new Date(e.ts).toISOString()} ${e.dir === 'out' ? 'SENT to' : 'RECEIVED from'} ${e.remote || ''}\n${e.text}`).join('\n\n'));

function showTab(name) {
  document.querySelectorAll('.tabs button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + name));
  if (name === 'log') renderLog();
}
document.querySelectorAll('.tabs button[data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------- Web edition: state after (re)connecting ----------
api.on('app:sync', s => {
  if (s.server) document.body.classList.add('web');
  if (s.sip) { state = s.sip.state; stateInfo = s.sip.state === 'ready' ? { key: '{transport} · local {local}', p: { transport: s.sip.transport, local: s.sip.local } } : null; }
  if (s.reg) { reg = s.reg; renderReg(); }
  renderState(); updateButtons();
  if (window.onLoadSync && s.load) window.onLoadSync(s.load);
});
if (window.api.web) {
  document.body.classList.add('web');
  const a = document.createElement('a'); a.href = '/logout'; a.className = 'logout'; a.textContent = t('Log out'); a.dataset.i18n = '';
  $('lang').before(a);
}
if (!/Mac/.test(navigator.platform)) document.body.classList.add('nomac');

I18N.onChange(() => {
  refreshProfiles($('profile').value);
  renderState(); renderReg();
  for (const c of calls.values()) { const tr = document.querySelector(`#callBody tr[data-id="${c.id}"]`); if (tr) tr.innerHTML = callRow(c); }
});

refreshProfiles(); renderState(); renderReg(); updateButtons();
