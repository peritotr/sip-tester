// Built-in vendor (trunk) controls in the left panel (uses $, val, setVal, esc, t, tm from renderer.js)
(() => {
  const FIELDS = ['mockHost', 'mockPort', 'mockRing', 'mockAnswer', 'mockHangup', 'mockMaxCps', 'mockChannels', 'mockCapacity', 'mockBusy', 'mockFail', 'mockFailCode', 'mockUser', 'mockPassword', 'mockEcho'];
  window.mockState = { on: false, opts: null, stats: null };
  let ipList = [], lastLog = [];

  const save = () => { const o = {}; FIELDS.forEach(f => { if (f !== 'mockPassword') o[f] = val(f); }); try { localStorage.setItem('vendorForm', JSON.stringify(o)); } catch {} };
  try { const o = JSON.parse(localStorage.getItem('vendorForm') || '{}'); for (const k in o) setVal(k, o[k]); } catch {}
  FIELDS.forEach(f => $(f).addEventListener('change', save));

  function opts() {
    return {
      host: val('mockHost'), port: Number(val('mockPort')) || 5080,
      ringMs: Number(val('mockRing')) || 0, answerMs: Number(val('mockAnswer')) || 0, hangupAfterMs: (Number(val('mockHangup')) || 0) * 1000,
      maxCps: Number(val('mockMaxCps')) || 0, maxChannels: Number(val('mockChannels')) || 0, capacity: Number(val('mockCapacity')) || 0,
      busyPct: Number(val('mockBusy')) || 0, failPct: Number(val('mockFail')) || 0, failCode: Number(val('mockFailCode')) || 480,
      user: val('mockUser').trim(), password: val('mockPassword'), echo: val('mockEcho'),
    };
  }

  $('mockToggle').onclick = async () => {
    $('mockToggle').disabled = true;
    try {
      if (mockState.on) await api.mockStop();
      else { const r = await api.mockStart(opts()); if (r && !r.ok) { addLog(r.error); alert(tm(r.error)); } }
    } finally { $('mockToggle').disabled = false; }
  };

  function render() {
    const on = mockState.on, o = mockState.opts || {};
    $('mockToggle').textContent = t(on ? 'Stop' : 'Start');
    $('mockToggle').className = on ? '' : 'primary';
    document.querySelectorAll(FIELDS.map(f => '#' + f).join(',')).forEach(e => e.disabled = on);
    if (!on) { $('mockAddr').innerHTML = ''; $('mockStats').textContent = ''; return; }
    const port = o.port || val('mockPort');
    const addrs = o.host === '0.0.0.0' ? ipList.map(i => i.address) : [o.host || '127.0.0.1'];
    $('mockAddr').innerHTML = esc(t('Add this as a trunk / outbound route on your PBX:')) + '<br>' +
      (addrs.length ? addrs.map(a => `<b>${esc(a)}:${esc(port)}</b>`).join(' · ') : esc(t('No IP found'))) + ` · UDP/TCP` +
      '<br><span class="muted">' + esc(o.user ? t('Auth: {user} / password', { user: o.user }) : o.password ? t('Auth: any username / password') : t('No authentication (IP trunk)')) +
      (o.host === '127.0.0.1' ? ' · ' + esc(t('this machine only')) : '') + '</span>';
    renderStats();
  }
  function renderStats() {
    const s = mockState.stats; if (!mockState.on || !s) return;
    $('mockStats').textContent = t('Calls {ps}/s · active {act} (peak {max}) · answered {ans} · rejected {rej} · RTP {rtp} pkt/s', {
      ps: s.invPs, act: s.active, max: s.maxActive, ans: s.answered, rej: s.rejected503 + s.full + s.busy + s.failed, rtp: s.rtpPps }) + (s.queue ? ' · ' + t('queue {n}', { n: s.queue }) : '');
  }
  function addLog(m) {
    if (!m) return;
    lastLog.unshift(`${new Date().toLocaleTimeString(I18N.locale, { hour12: false })} ${tm(m)}`); lastLog = lastLog.slice(0, 5);
    $('mockLog').textContent = lastLog.join('\n');
  }

  api.on('mock:state', st => { mockState.on = !!st.on; mockState.opts = st.opts || null; if (!st.on) mockState.stats = null; else fillFrom(st.opts); render(); });
  api.on('mock:stats', s => { mockState.stats = s; renderStats(); });
  api.on('mock:log', addLog);
  // Show the settings the running vendor actually uses (e.g. restored after a server restart)
  function fillFrom(o) {
    if (!o) return;
    const map = { host: 'mockHost', port: 'mockPort', ringMs: 'mockRing', answerMs: 'mockAnswer', maxCps: 'mockMaxCps', maxChannels: 'mockChannels', capacity: 'mockCapacity',
      busyPct: 'mockBusy', failPct: 'mockFail', failCode: 'mockFailCode', user: 'mockUser', echo: 'mockEcho' };
    for (const [k, f] of Object.entries(map)) if (o[k] !== undefined) setVal(f, o[k]);
    if (o.hangupAfterMs !== undefined) setVal('mockHangup', o.hangupAfterMs / 1000);
  }
  api.on('app:sync', s => { if (s.mock) { mockState.on = !!s.mock.on; mockState.opts = s.mock.opts; fillFrom(s.mock.opts); render(); } });
  api.ips().then(l => { ipList = l || []; render(); }).catch(() => {});
  I18N.onChange(() => { render(); });
  render();
})();
