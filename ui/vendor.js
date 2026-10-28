// Built-in vendor (trunk) controls in the left panel (uses $, val, setVal, esc, t, tm from renderer.js)
// The vendor can run up to four trunks (A–D), each on its own port with its own behaviour, so a PBX can be tested
// with a primary and a backup carrier. The form shows one trunk at a time; the listen address is shared.
(() => {
  const TF = ['mockPort', 'mockRing', 'mockAnswer', 'mockHangup', 'mockMaxCps', 'mockChannels', 'mockCapacity', 'mockBusy', 'mockFail', 'mockFailCode', 'mockUser', 'mockPassword', 'mockEcho'];
  const NAMES = 'ABCD';
  window.mockState = { on: false, opts: null, stats: null };
  let ipList = [], lastLog = [], trunks = [], cur = 0;

  const readForm = () => { const o = {}; TF.forEach(f => o[f] = val(f)); return o; };
  const writeForm = o => TF.forEach(f => { if (o && o[f] !== undefined) setVal(f, o[f]); });
  const sync = () => { trunks[cur] = readForm(); };

  const save = () => {
    sync();
    const list = trunks.map(o => { const c = { ...o }; delete c.mockPassword; return c; }); // passwords are never kept in the browser
    try { localStorage.setItem('vendorForm', JSON.stringify({ mockHost: val('mockHost'), trunks: list, cur })); } catch {}
  };
  // Restore; older versions stored a single flat form
  try {
    const o = JSON.parse(localStorage.getItem('vendorForm') || '{}');
    if (o.mockHost) setVal('mockHost', o.mockHost);
    if (Array.isArray(o.trunks) && o.trunks.length) { trunks = o.trunks.slice(0, NAMES.length); cur = Math.min(o.cur || 0, trunks.length - 1); writeForm(trunks[cur]); }
    else { writeForm(o); trunks = [readForm()]; }
  } catch { trunks = [readForm()]; }
  if (!trunks.length) trunks = [readForm()];
  ['mockHost', ...TF].forEach(f => $(f).addEventListener('change', save));

  function trunkOpts(o) {
    const n = (v, d = 0) => Number(v) || d;
    return {
      port: n(o.mockPort, 5080), ringMs: n(o.mockRing), answerMs: n(o.mockAnswer), hangupAfterMs: n(o.mockHangup) * 1000,
      maxCps: n(o.mockMaxCps), maxChannels: n(o.mockChannels), capacity: n(o.mockCapacity),
      busyPct: n(o.mockBusy), failPct: n(o.mockFail), failCode: n(o.mockFailCode, 480),
      user: String(o.mockUser || '').trim(), password: o.mockPassword || '', echo: o.mockEcho !== false,
    };
  }
  function opts() {
    sync();
    const list = trunks.map(trunkOpts);
    return { host: val('mockHost'), ...list[0], trunks: list.length > 1 ? list : undefined };
  }

  function renderTabs() {
    const on = mockState.on, n = trunks.length;
    $('mockTrunks').innerHTML = trunks.map((_, i) => `<button data-i="${i}" class="${i === cur ? 'on' : ''}">${esc(t('Trunk {name}', { name: NAMES[i] }))}</button>`).join('')
      + (n < NAMES.length && !on ? `<button class="add" data-add title="${esc(t('Add a backup trunk on the next port'))}">+ ${esc(t('Trunk'))}</button>` : '')
      + '<span class="spacer"></span>'
      + (n > 1 && !on ? `<button class="ghost" data-rm title="${esc(t('Remove trunk {name}', { name: NAMES[cur] }))}">✕</button>` : '');
    $('mockTrunkHint').hidden = n < 2;
  }
  $('mockTrunks').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    sync();
    if (b.dataset.i !== undefined) cur = Number(b.dataset.i);
    else if (b.dataset.add !== undefined) {
      const last = trunks[trunks.length - 1];
      trunks.push({ ...last, mockPort: String((Number(last.mockPort) || 5080) + 1), mockChannels: '0', mockMaxCps: '0', mockCapacity: '0', mockBusy: '0', mockFail: '0' });
      cur = trunks.length - 1;
    } else if (b.dataset.rm !== undefined && trunks.length > 1) { trunks.splice(cur, 1); cur = Math.max(0, cur - 1); }
    writeForm(trunks[cur]); renderTabs(); save(); render();
  });

  $('mockToggle').onclick = async () => {
    $('mockToggle').disabled = true;
    try {
      if (mockState.on) await api.mockStop();
      else {
        const o = opts(), ports = (o.trunks || [o]).map(x => x.port);
        if (new Set(ports).size < ports.length) { alert(t('Every trunk needs its own port.')); return; }
        const r = await api.mockStart(o); if (r && !r.ok) { addLog(r.error); alert(tm(r.error)); }
      }
    } finally { $('mockToggle').disabled = false; }
  };

  function render() {
    const on = mockState.on, o = mockState.opts || {};
    $('mockToggle').textContent = t(on ? 'Stop' : 'Start');
    $('mockToggle').className = on ? '' : 'primary';
    document.querySelectorAll(['mockHost', ...TF].map(f => '#' + f).join(',')).forEach(e => e.disabled = on);
    renderTabs();
    if (!on) { $('mockAddr').innerHTML = ''; $('mockStats').textContent = ''; return; }
    const addrs = o.host === '0.0.0.0' ? ipList.map(i => i.address) : [o.host || '127.0.0.1'];
    const list = o.trunks && o.trunks.length > 1 ? o.trunks : [o];
    const auth = x => x.user ? t('Auth: {user} / password', { user: x.user }) : x.password ? t('Auth: any username / password') : t('No authentication (IP trunk)');
    const line = (x, i) => (list.length > 1 ? `${esc(NAMES[i])} → ` : '')
      + (addrs.length ? addrs.map(a => `<b>${esc(a)}:${esc(x.port)}</b>`).join(' · ') : esc(t('No IP found')))
      + (list.length > 1 ? ` <span class="muted">· ${esc(auth(x))}</span>` : '');
    $('mockAddr').innerHTML = esc(t(list.length > 1 ? 'Add these as trunks on your PBX (A first, then the backups):' : 'Add this as a trunk / outbound route on your PBX:')) + '<br>'
      + list.map(line).join('<br>') + ' · UDP/TCP'
      + '<br><span class="muted">' + (list.length > 1 ? '' : esc(auth(o))) + (o.host === '127.0.0.1' ? (list.length > 1 ? '' : ' · ') + esc(t('this machine only')) : '') + '</span>';
    renderStats();
  }
  function renderStats() {
    const s = mockState.stats; if (!mockState.on || !s) return;
    const one = x => t('Calls {ps}/s · active {act} (peak {max}) · answered {ans} · rejected {rej} · RTP {rtp} pkt/s', {
      ps: x.invPs, act: x.active, max: x.maxActive, ans: x.answered, rej: x.rejected503 + x.full + x.busy + x.failed, rtp: x.rtpPps }) + (x.queue ? ' · ' + t('queue {n}', { n: x.queue }) : '');
    $('mockStats').textContent = s.trunks && s.trunks.length > 1 ? s.trunks.map(x => `${x.name}: ${one(x)}`).join('\n') : one(s);
  }
  function addLog(m) {
    if (!m) return;
    lastLog.unshift(`${new Date().toLocaleTimeString(I18N.locale, { hour12: false })} ${tm(m)}`); lastLog = lastLog.slice(0, 5);
    $('mockLog').textContent = lastLog.join('\n');
  }

  // Show the settings the running vendor actually uses (e.g. restored after a server restart)
  function toForm(o, prev) {
    const f = { mockPort: o.port, mockRing: o.ringMs, mockAnswer: o.answerMs, mockHangup: o.hangupAfterMs !== undefined ? o.hangupAfterMs / 1000 : undefined,
      mockMaxCps: o.maxCps, mockChannels: o.maxChannels, mockCapacity: o.capacity, mockBusy: o.busyPct, mockFail: o.failPct, mockFailCode: o.failCode,
      mockUser: o.user, mockEcho: o.echo, mockPassword: prev ? prev.mockPassword : '' };
    const out = { ...(prev || {}) }; for (const k in f) if (f[k] !== undefined) out[k] = f[k];
    return out;
  }
  function fillFrom(o) {
    if (!o) return;
    sync();
    if (o.host) setVal('mockHost', o.host);
    const list = o.trunks && o.trunks.length ? o.trunks : [o];
    trunks = list.map((x, i) => toForm(x, trunks[i]));
    cur = Math.min(cur, trunks.length - 1);
    writeForm(trunks[cur]);
  }
  api.on('mock:state', st => { mockState.on = !!st.on; mockState.opts = st.opts || null; if (!st.on) mockState.stats = null; else fillFrom(st.opts); render(); });
  api.on('mock:stats', s => { mockState.stats = s; renderStats(); });
  api.on('mock:log', addLog);
  api.on('app:sync', s => { if (s.mock) { mockState.on = !!s.mock.on; mockState.opts = s.mock.opts; fillFrom(s.mock.opts); render(); } });
  api.ips().then(l => { ipList = l || []; render(); }).catch(() => {});
  I18N.onChange(() => { render(); });
  render();
})();
