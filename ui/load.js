// Load test view (uses $, val, setVal, esc, t, tm, connCfg from renderer.js)
const LOAD_FIELDS = ['lScenario','lName','lDst','lUsers','lPassTpl','lRate','lMode','lAmount','lStepStart','lStepInc','lStepDur','lRamp','lConcurrent','lHoldMin','lHoldMax','lMaxRing',
  'lExpires','lConnections','lRespTimeout','lRtpMax','lCodec','lRtp','lBackoff','lReuseNonce','lE2e','cP95','cP99','cAsr','cE2e','cMiss','cErr','cLoss','cMinRate'];
const fmt = n => n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString(I18N.locale);
const fr = n => n == null || isNaN(n) ? '—' : (n < 10 && n % 1 ? n.toFixed(1) : Math.round(n).toLocaleString(I18N.locale));
const fms = n => n == null || isNaN(n) ? '—' : (n < 10 ? n.toFixed(1) : Math.round(n).toString());

let series = [], lastResult = null, loadRunning = false, testStartedAt = null, lastTotals = null, lastReportId = null, lastVerdict = null, runScenario = null;
let phaseMsg = null, runE2e = null;
let foShown = false; // the failover line appears once a test with several trunks reports
const sc = () => runScenario || val('lScenario');
const unit = s => (s || sc()) === 'call' ? 'CPS' : 'RPS';

// ---------- Mode switch ----------
document.querySelectorAll('.modes button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.modes button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + b.dataset.mode));
  try { localStorage.setItem('mode', b.dataset.mode); } catch {}
  if (b.dataset.mode === 'load') redraw();
});

// ---------- Persisted form ----------
function saveLoadForm() { const o = {}; LOAD_FIELDS.forEach(f => o[f] = val(f)); try { localStorage.setItem('loadForm', JSON.stringify(o)); } catch {} }
try { const o = JSON.parse(localStorage.getItem('loadForm') || '{}'); for (const k in o) setVal(k, o[k]); } catch {}
$('view-load').addEventListener('change', saveLoadForm);

// Labels that depend on the scenario
function updScenario() {
  const s = sc(), v = $('view-load');
  v.classList.remove('sc-call', 'sc-register', 'sc-options'); v.classList.add('sc-' + s);
  v.classList.toggle('nortp', !val('lRtp'));
  v.classList.toggle('noe2e', !(s === 'call' && (runE2e != null ? runE2e : val('lE2e'))));
  v.classList.toggle('steps', val('lMode') === 'steps');
  const call = s === 'call';
  $('lRateLbl').textContent = t(call ? 'Target CPS' : 'Target RPS');
  $('lConcLbl').textContent = t(call ? 'Max concurrent calls' : 'Max requests in flight');
  $('lUsersLbl').textContent = t(s === 'register' ? 'Accounts to register' : 'Accounts (rotate)');
  $('lAmountLbl').textContent = val('lMode') === 'total' ? t(call ? 'Calls' : 'Requests') : t('Duration (s)');
  $('kSentLbl').textContent = t(call ? 'Call attempts' : s === 'register' ? 'REGISTER sent' : 'OPTIONS sent');
  $('kOkLbl').textContent = $('kOkLbl2').textContent = t(call ? 'Answered' : s === 'register' ? 'Registered' : 'Answered (2xx)');
  $('kActLbl').textContent = t(call ? 'Active calls' : 'In flight');
  $('kLatLbl').textContent = t(call ? 'PDD p50 / p95 / p99' : 'Response p50 / p95 / p99');
  $('kU1').textContent = $('kU2').textContent = unit(s);
  $('cRateTitle').textContent = t(call ? 'Calls per second' : 'Requests per second');
  $('cLatTitle').textContent = t(call ? 'Setup latency (ms)' : 'Response latency (ms)');
  $('cActTitle').textContent = t(call ? 'Active calls' : 'In flight');
  $('cP95Lbl').textContent = t(call ? 'PDD p95 ≤ (ms)' : 'Response p95 ≤ (ms)');
  $('cP99Lbl').textContent = t(call ? 'PDD p99 ≤ (ms)' : 'Response p99 ≤ (ms)');
  legends(); updStepInfo();
}
function updStepInfo() {
  if (val('lMode') !== 'steps' || loadRunning) { if (!loadRunning && phaseMsg && phaseMsg.msg && phaseMsg.msg.step) setPhase(''); return; }
  const a = Number(val('lStepStart')) || 1, inc = Number(val('lStepInc')) || 1, max = Number(val('lRate')) || a, d = Number(val('lStepDur')) || 60;
  const n = Math.max(1, Math.ceil((max - a) / inc - 1e-9) + 1);
  setPhase({ step: true, key: '{n} steps · {from} → {to} {unit} · ~{min} min total', p: { n, from: fr(a), to: fr(max), unit: unit(), min: Math.round(n * d / 60) } });
}
['lStepStart','lStepInc','lStepDur','lRate'].forEach(id => $(id).addEventListener('input', updStepInfo));
['lMode','lScenario','lRtp','lE2e'].forEach(id => $(id).addEventListener('change', updScenario));

// ---------- Start / stop ----------
$('lStart').onclick = async () => {
  if (!val('host').trim()) { alert(t('Enter the server details on the left first.')); $('host').focus(); return; }
  const s = val('lScenario');
  if (s === 'call' && !val('lDst').trim()) { alert(t('Enter a destination to call.')); $('lDst').focus(); return; }
  if (s === 'register' && !val('lUsers').trim() && !val('user').trim()) { alert(t('Enter the accounts to register (e.g. 1000-1499).')); $('lUsers').focus(); return; }
  const rate = Number(val('lRate')), hold = (Number(val('lHoldMin')) + Number(val('lHoldMax'))) / 2;
  if (s === 'call' && Number(val('lConcurrent')) < rate * (hold + 1) * 0.9) {
    if (!confirm(t('At {rate} CPS with ~{hold} s calls you need about {need} concurrent calls, but the limit is {lim}. The target rate will not be reached. Start anyway?', { rate: fr(rate), hold: fr(hold), need: fmt(rate * (hold + 1)), lim: fmt(val('lConcurrent')) }))) return;
  }
  const e2e = s === 'call' && val('lE2e');
  if (e2e && !/[xX]{4,}$/.test(val('lDst').trim().split(/[\s,;]+/)[0] || '')) { alert(t('For end-to-end measurement the destination must end with at least 4 X, e.g. 8XXXXXXX. Route that prefix to the vendor on your PBX.')); $('lDst').focus(); return; }
  if (e2e && !window.mockState.on && !confirm(t('End-to-end measurement needs the vendor on the left to be running and your PBX to route the calls to it. The vendor is stopped. Start anyway?'))) return;
  const cfg = connCfg();
  const test = {
    scenario: s, name: val('lName').trim(), rate: val('lRate'), concurrent: val('lConcurrent'), connections: val('lConnections'),
    total: val('lMode') === 'total' ? val('lAmount') : 0, duration: val('lMode') === 'duration' ? val('lAmount') : 0,
    steps: val('lMode') === 'steps' ? { start: val('lStepStart'), inc: val('lStepInc'), dur: val('lStepDur') } : null,
    ramp: val('lRamp'), respTimeout: val('lRespTimeout'),
    dst: val('lDst'), users: val('lUsers'), passTpl: val('lPassTpl'), holdMin: val('lHoldMin'), holdMax: val('lHoldMax'), maxRing: val('lMaxRing'),
    expires: val('lExpires'), e2e, rtp: val('lRtp'), rtpMax: val('lRtpMax'), codec: val('lCodec'), backoff503: val('lBackoff'), reuseNonce: val('lReuseNonce'),
    criteria: {
      p95Max: Number(val('cP95')) || null, p99Max: Number(val('cP99')) || null,
      asrMin: s === 'call' && val('cAsr') !== '' ? Number(val('cAsr')) : null,
      e2eP95Max: e2e ? (Number(val('cE2e')) || null) : null, e2eMissMaxPct: e2e && val('cMiss') !== '' ? Number(val('cMiss')) : null,
      errMaxPct: val('cErr') === '' ? null : Number(val('cErr')),
      rtpLossMaxPct: s === 'call' && val('lRtp') && val('cLoss') !== '' ? Number(val('cLoss')) : null,
      minTps: Number(val('cMinRate')) || Number(val('lRate')),
    },
  };
  runScenario = s; runE2e = e2e; series = []; lastTotals = null; testStartedAt = new Date();
  lastResult = { cfg: { host: cfg.host, port: cfg.port, transport: cfg.transport, user: cfg.user }, test };
  resetKpis(); updScenario(); redraw();
  setRunning(true); setPhase('Starting…');
  const r = await api.loadStart(cfg, test);
  if (r && r.ok === false) { setRunning(false); setPhase({ prefix: 'Error', body: r.error }, 'err'); }
};
$('lStop').onclick = () => {
  api.loadStop();
  setPhase(sc() === 'call' ? 'Stopping new calls… (press again to hang up all active calls now)' : 'Stopping… (press again to finish without waiting)');
};

function setRunning(r) {
  if (r) $('lReport').style.display = 'none';
  loadRunning = r;
  $('lStart').disabled = r; $('lStop').disabled = !r; $('lCsv').disabled = r || !series.length;
  document.querySelectorAll('#view-load .compose input, #view-load .compose select').forEach(e => e.disabled = r);
  if (!r) { runScenario = null; runE2e = null; }
}
function setPhase(msg, cls) { phaseMsg = { msg, cls }; renderPhase(); }
function renderPhase() {
  if (!phaseMsg) return;
  const { msg, cls } = phaseMsg;
  $('lPhase').textContent = msg && msg.prefix ? t(msg.prefix) + ': ' + tm(msg.body) : tm(msg);
  $('lPhase').className = cls || 'muted';
}

api.on('load:phase', m => {
  if (m.phase === 'error') { setRunning(false); setPhase({ prefix: 'Error', body: m }, 'err'); }
  else if (m.phase === 'done') { setRunning(false); updScenario(); setPhase('Test finished', 'ok'); }
  else setPhase(m);
});
api.on('load:log', m => { const n = $('lNotes'); n.textContent = tm(m) + '\n' + n.textContent; });
api.on('load:tick', m => {
  lastTotals = m.totals; series.push(m.row);
  if (!runScenario && m.totals.scenario) runScenario = m.totals.scenario;
  $('kSentTps').textContent = fr(m.row.sentTps);
  $('kOkTps').textContent = fr(m.row.okTps);
  renderTotals(m.totals, m.row);
  redraw();
});
api.on('load:done', m => {
  loadRunning = false; // final totals: render them as finished
  lastResult = lastResult || {}; lastResult.totals = m.totals; lastTotals = m.totals; series = series.length ? series : m.series;
  renderTotals(m.totals);
  $('kSentTps').textContent = '—'; $('kOkTps').textContent = '—'; $('kActive').textContent = '0';
  $('lCsv').disabled = false;
  redraw();
});

function resetKpis() {
  ['kSentTps','kOkTps','kActive','kLat','kAsr','kAvg','rPkts','rLoss','rJit','rRtt'].forEach(id => $(id).textContent = '—');
  ['kSent','kOk','kErr','kThr','kTo','kRetr','kBye','kCh'].forEach(id => $(id).textContent = '0');
  ['eRx','eMiss','eDup','eLat'].forEach(id => { $(id).textContent = '—'; $(id).className = ''; });
  $('kActMax').textContent = '';
  $('tErrs').innerHTML = '<tr><td class="muted">—</td></tr>'; $('tTiming').innerHTML = '<tr><td class="muted">—</td></tr>';
}
function renderTotals(T, r) {
  if (!T) return;
  $('kSent').textContent = fmt(T.sent); $('kOk').textContent = fmt(T.ok); $('kErr').textContent = fmt(T.err);
  $('kThr').textContent = fmt(T.throttled); $('kTo').textContent = fmt(T.timeouts); $('kRetr').textContent = fmt(T.retrans);
  $('kActive').textContent = r ? fmt(r.inflight) : fmt(T.active || 0);
  $('kActMax').textContent = T.maxActive ? t('peak {n}', { n: fmt(T.maxActive) }) : '';
  $('kCh').textContent = fmt(T.challenges); $('kAvg').textContent = fr(T.avgTps) + ' ' + unit(T.scenario);
  const l = T.lat || {};
  $('kLat').textContent = l.n ? `${fms(l.p50)} / ${fms(l.p95)} / ${fms(l.p99)}` : '—';
  if (T.scenario === 'call') {
    $('kAsr').textContent = T.asr == null ? '—' : T.asr.toFixed(T.asr > 99.9 && T.asr < 100 ? 2 : 1) + '%';
    $('kBye').textContent = `${fmt(T.completed)} · ${fmt(T.dropped)}`; $('kBye').className = T.dropped ? 'err' : '';
    if (T.rtpCalls || (r && r.rtpCalls)) {
      $('rPkts').textContent = `${fmt(T.rtpTx)} / ${fmt(T.rtpRx)}` + (r && r.rtpCalls ? ' · ' + t('{n} live', { n: fmt(r.rtpCalls) }) : '');
      const live = r && r.rtpLoss != null ? r.rtpLoss : null;
      $('rLoss').textContent = (T.rtpLossPct != null ? T.rtpLossPct.toFixed(2) + '%' : '—') + (live != null && loadRunning ? ' · ' + t('now {p}%', { p: live.toFixed(2) }) : '') + (T.noMedia ? ' · ' + t('{n} calls without audio', { n: fmt(T.noMedia) }) : '');
      $('rLoss').className = T.rtpLossPct > 1 || T.noMedia ? 'err' : '';
      const j = T.jitter || {}; $('rJit').textContent = j.n ? `${fms(j.p50)} / ${fms(j.p95)} ms` : (r && r.jitter != null ? fms(r.jitter) + ' ms' : '—');
      const q = T.rtt || {}; $('rRtt').textContent = q.n ? `${fms(q.p50)} / ${fms(q.p95)} ms` : (r && r.rttP95 != null ? fms(r.rttP95) + ' ms' : '—');
    }
  }
  if (!T.e2e || !T.e2e.trunks || T.e2e.trunks.length < 2) $('trPanel').hidden = true;
  if (T.e2e) {
    const E = T.e2e, l = E.lat || {};
    $('eRx').textContent = fmt(E.reached) + (E.sent ? ` (${(E.reached / E.sent * 100).toFixed(E.reached === E.sent ? 0 : 2)}%)` : '');
    $('eMiss').textContent = fmt(E.missing) + (loadRunning ? ' · ' + t('incl. in progress') : E.sent ? ` (${(E.missing / E.sent * 100).toFixed(2)}%)` : '');
    $('eMiss').className = !loadRunning && E.missing ? 'err' : '';
    $('eDup').textContent = fmt(E.dup) + (E.unmatched ? ' · ' + t('{n} unknown', { n: fmt(E.unmatched) }) : ''); $('eDup').className = E.dup ? 'err' : '';
    $('eLat').textContent = l.n ? `${fms(l.p50)} / ${fms(l.p95)} / ${fms(l.p99)} ms` : '—';
    // Several trunks: who took the calls, and how many failed over
    const TR = E.trunks || [], multi = TR.length > 1;
    $('trPanel').hidden = !multi;
    if (multi !== foShown) { foShown = multi; legends(); }
    if (multi) {
      const acc = TR.reduce((a, x) => a + x.acc, 0);
      $('eTr').textContent = TR.map((x, i) => `${'ABCD'[i]} ${acc ? Math.round(x.acc / acc * 100) : 0}%`).join(' · ');
      $('eTr').title = TR.map((x, i) => t('Trunk {name}: {att} attempts, {acc} taken, {rej} rejected', { name: 'ABCD'[i], att: fmt(x.att), acc: fmt(x.acc), rej: fmt(x.rej) })).join('\n');
      $('eFo').textContent = fmt(E.failover || 0) + (E.reached ? ` (${((E.failover || 0) / E.reached * 100).toFixed(1)}%)` : '');
      const f = E.foLat || {}; $('eFoLat').textContent = f.n ? `${fms(f.p50)} / ${fms(f.p95)} ms` : '—';
      $('eAllRej').textContent = fmt(E.allRejected || 0); $('eAllRej').className = !loadRunning && E.allRejected ? 'err' : '';
    }
  }
  const errs = Object.entries(T.errs || {}).sort((a, b) => b[1] - a[1]);
  $('tErrs').innerHTML = errs.length ? errs.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${fmt(v)}</td></tr>`).join('') : `<tr><td class="muted">${t('No failures')}</td></tr>`;
  const H = (label, h) => h && h.n ? `<tr><td class="l">${esc(label)}</td><td class="r">${fms(h.p50)}</td><td class="r">${fms(h.p95)}</td><td class="r">${fms(h.p99)}</td><td class="r">${fms(h.max)}</td></tr>` : '';
  const rows = T.scenario === 'call'
    ? H(t('INVITE → 100 Trying'), T.t100) + (T.e2e ? H(t('INVITE → vendor (routing)'), T.e2e.lat) + (T.e2e.foLat ? H(t('Failover (first trunk → taken)'), T.e2e.foLat) : '') : '') + H(t('PDD (INVITE → 180/183)'), T.lat) + H(t('INVITE → 200 OK'), T.ans) + H(t('BYE → 200 OK'), T.bye)
    : H(t(T.scenario === 'register' ? 'REGISTER → 200 OK (with challenge)' : 'OPTIONS → response'), T.lat);
  $('tTiming').innerHTML = rows ? `<tr><td class="l">ms</td><td class="r l">p50</td><td class="r l">p95</td><td class="r l">p99</td><td class="r l">max</td></tr>${rows}` : '<tr><td class="muted">—</td></tr>';
}

// ---------- Charts (plain canvas) ----------
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const RATE_LINES = () => [
  { k: 'target', label: 'Target', c: '--muted', dash: true },
  { k: 'sentTps', label: sc() === 'call' ? 'Attempts' : 'Sent', c: '--accent' },
  { k: 'okTps', label: sc() === 'call' ? 'Answered' : 'OK', c: '--ok' },
  { k: 'thrTps', label: '503', c: '--warn' },
  { k: 'errTps', label: 'Failed', c: '--err' },
  { k: 'retrTps', label: 'Retransmissions', c: '--violet' },
  ...(foShown ? [{ k: 'e2eFoTps', label: 'Failovers', c: '--accent', dash: true }] : []),
];
const LAT_LINES = () => sc() === 'call'
  ? [{ k: 'p50', label: 'PDD p50', c: '--ok' }, { k: 'p95', label: 'PDD p95', c: '--warn' }, { k: 'p99', label: 'PDD p99', c: '--err' }, { k: 't100P95', label: '100 Trying p95', c: '--violet' }, ...((runE2e != null ? runE2e : val('lE2e')) ? [{ k: 'e2eP95', label: 'Routing p95', c: '--accent' }] : [])]
  : [{ k: 'p50', label: 'p50', c: '--ok' }, { k: 'p95', label: 'p95', c: '--warn' }, { k: 'p99', label: 'p99', c: '--err' }];
const ACT_LINES = () => [{ k: 'inflight', label: sc() === 'call' ? 'Active calls' : 'In flight', c: '--accent' }, ...(sc() === 'call' ? [{ k: 'rtpCalls', label: 'With RTP', c: '--violet' }] : [])];
const RTP_LINES = () => [{ k: 'rtpLoss', label: 'Loss %', c: '--err' }, { k: 'jitter', label: 'Jitter ms', c: '--warn' }, { k: 'rttP95', label: 'Echo RTT p95 ms', c: '--violet' }];
function legend(el, lines) { el.innerHTML = lines.map(l => `<i style="background:${css(l.c)}"></i>${esc(t(l.label))}`).join(' '); }
function legends() { legend($('lgTps'), RATE_LINES()); legend($('lgLat'), LAT_LINES()); legend($('lgAct'), ACT_LINES()); legend($('lgRtp'), RTP_LINES()); }

function drawChart(cv, lines, target) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  const L = 52, R = 10, T = 8, B = 22, w = W - L - R, h = H - T - B;
  let max = target || 0;
  for (const r of series) for (const l of lines) if (r[l.k] > max) max = r[l.k];
  if (!max) max = 1;
  const raw = max * 1.08 / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const stepN = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(m => m * mag >= raw) * mag; max = stepN * 4;
  const n = Math.max(series.length, 10);
  const x = i => L + (n <= 1 ? 0 : i / (n - 1) * w), y = v => T + h - v / max * h;
  g.font = '10.5px -apple-system, sans-serif'; g.fillStyle = css('--muted'); g.strokeStyle = css('--line'); g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4, yy = Math.round(y(v)) + .5;
    g.beginPath(); g.moveTo(L, yy); g.lineTo(L + w, yy); g.stroke();
    g.textAlign = 'right'; g.fillText(v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : (v < 10 && v % 1 ? v.toFixed(1) : Math.round(v)), L - 6, yy + 3.5);
  }
  g.textAlign = 'center';
  const step = Math.max(1, Math.ceil(n / 8)), t0 = series.length ? series[0].t : 1;
  for (let i = 0; i < n; i += step) g.fillText((series[i]?.t ?? t0 + i) + 's', x(i), H - 6);
  g.lineWidth = 2; g.lineJoin = 'round';
  for (const l of lines) {
    if (!series.some(r => r[l.k] > 0)) continue;
    g.strokeStyle = css(l.c); g.setLineDash(l.dash ? [5, 4] : []); g.lineWidth = l.dash ? 1.5 : 2; g.beginPath(); let started = false;
    series.forEach((r, i) => { const v = r[l.k]; if (v == null) { started = false; return; } started ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)); started = true; });
    g.stroke(); g.setLineDash([]);
  }
}
function redraw() {
  if (!$('view-load').classList.contains('on')) return;
  drawChart($('cTps'), RATE_LINES(), series.length ? 0 : Number(val('lRate')));
  drawChart($('cLat'), LAT_LINES()); drawChart($('cAct'), ACT_LINES());
  if (sc() === 'call') drawChart($('cRtp'), RTP_LINES());
}
window.addEventListener('resize', redraw);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { legends(); redraw(); });

// ---------- CSV ----------
function csvFormat() { return I18N.lang === 'tr' ? { sep: ';', dec: ',' } : { sep: ',', dec: '.' }; }
$('lCsv').onclick = () => {
  if (!series.length) return;
  const { sep, dec } = csvFormat();
  const r = lastResult || {}, T = r.totals || lastTotals || {}, l = T.lat || {}, te = r.test || {};
  const num = v => v == null || isNaN(v) ? '' : (Number.isInteger(v) ? String(v) : v.toFixed(2)).replace('.', dec);
  const row = a => a.map(v => typeof v === 'number' ? num(v) : String(v ?? '').replace(new RegExp(sep, 'g'), ' ')).join(sep);
  const nTr = T.e2e && T.e2e.trunks ? T.e2e.trunks.length : 0, trunkCols = nTr > 1 ? T.e2e.trunks.map((_, i) => `trunk_${'abcd'[i]}_taken_ps`) : [];
  const lines = [
    '# ' + t('SIP Tester load test'),
    row(['# ' + t('Date'), testStartedAt ? testStartedAt.toISOString() : '']),
    row(['# ' + t('Server'), `${r.cfg?.host}:${r.cfg?.port}`, r.cfg?.transport, r.cfg?.user]),
    row(['# ' + t('Scenario'), te.scenario, t('Target'), te.rate, unit(te.scenario), t('Duration (s)'), te.duration || '', t('Count'), te.total || '']),
    row(['# ' + t('Attempts'), T.sent, 'OK', T.ok, t('Failed'), T.err, '503', T.throttled, t('Timeouts'), T.timeouts, t('Retransmissions'), T.retrans]),
    row(['# ms', 'p50', l.p50, 'p95', l.p95, 'p99', l.p99, 'max', l.max]),
    ...(T.scenario === 'call' ? [row(['# ' + t('Calls'), 'ASR %', T.asr, t('Completed'), T.completed, t('Dropped'), T.dropped, 'RTP loss %', T.rtpLossPct])] : []),
    ...(T.e2e ? [row(['# ' + t('End-to-end'), t('Reached the vendor'), T.e2e.reached, t('Not reached'), T.e2e.missing, t('Duplicates'), T.e2e.dup, 'routing p50 ms', T.e2e.lat.p50, 'p95', T.e2e.lat.p95, 'p99', T.e2e.lat.p99])] : []),
    ...(T.e2e && T.e2e.trunks && T.e2e.trunks.length > 1 ? [row(['# ' + t('Trunks'), ...T.e2e.trunks.flatMap((x, i) => ['ABCD'[i], `${x.att}/${x.acc}/${x.rej}`]), t('Failovers'), T.e2e.failover, t('Rejected by all trunks'), T.e2e.allRejected, 'failover p95 ms', T.e2e.foLat && T.e2e.foLat.p95])] : []),
    row(['# ' + t('Failure codes'), Object.entries(T.errs || {}).map(([k, v]) => k + '=' + v).join(' ')]),
    '',
    ['second', 'target', 'sent_ps', 'ok_ps', 'failed_ps', '503_ps', 'timeout_ps', 'retrans_ps', 'active', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'answer_p95_ms', 'trying_p95_ms', 'bye_ps', 'dropped_ps', 'rtp_calls', 'rtp_loss_pct', 'jitter_ms', 'echo_rtt_p95_ms', 'vendor_rx_ps', 'routing_p50_ms', 'routing_p95_ms', 'routing_p99_ms', 'failover_ps', ...trunkCols].join(sep),
    ...series.map(s => row([s.t, s.target, s.sentTps, s.okTps, s.errTps, s.thrTps, s.toTps, s.retrTps, s.inflight, s.p50, s.p95, s.p99, s.max, s.ansP95, s.t100P95, s.byeTps, s.dropTps, s.rtpCalls, s.rtpLoss, s.jitter, s.rttP95, s.e2eRxTps, s.e2eP50, s.e2eP95, s.e2eP99, s.e2eFoTps, ...trunkCols.map((_, i) => s.e2eTr ? s.e2eTr[i] : null)])),
  ];
  api.saveFile('﻿' + lines.join('\n'), `sip-load-test-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`);
};

// Web edition: restore a running test after a page reload
window.onLoadSync = ld => {
  const active = ['connecting', 'running', 'draining'].includes(ld.phase);
  if (ld.test && ld.test.scenario) { setVal('lScenario', ld.test.scenario); if (active) { runScenario = ld.test.scenario; runE2e = !!ld.test.e2e; } }
  if (active && !loadRunning) { setRunning(true); runScenario = ld.test && ld.test.scenario || runScenario; setPhase(ld.key || ld.text ? ld : 'Running'); document.querySelector('.modes [data-mode=load]').click(); }
  if (ld.reportId && !active) { lastReportId = ld.reportId; showReportButton(); }
  if (ld.series && ld.series.length && !series.length) {
    series = ld.series.slice();
    if (ld.totals) { lastTotals = ld.totals; renderTotals(ld.totals, series[series.length - 1]); if (!active) { lastResult = { ...(lastResult || {}), totals: ld.totals }; $('lCsv').disabled = false; } }
    if (!active && ld.phase === 'done') setPhase('Last test finished', 'ok');
  }
  updScenario(); redraw();
};

function showReportButton() {
  const b = $('lReport'); b.style.display = '';
  b.textContent = lastVerdict === 'pass' ? t('Open report · Passed') : lastVerdict === 'fail' ? t('Open report · Failed') : t('Open report');
  b.className = lastVerdict === 'fail' ? 'ghost err' : lastVerdict === 'pass' ? 'ghost ok' : 'ghost';
}
api.on('report:saved', e => { lastReportId = e.id; lastVerdict = e.verdict; showReportButton(); if (window.refreshReports) window.refreshReports(); });
$('lReport').onclick = () => lastReportId && api.reportOpen(lastReportId);

I18N.onChange(() => {
  updScenario(); renderPhase(); redraw();
  if (lastTotals) renderTotals(lastTotals, loadRunning ? series[series.length - 1] : null);
  if ($('lReport').style.display !== 'none') showReportButton();
});

updScenario();
try { const m = localStorage.getItem('mode'); if (m && m !== 'single') document.querySelector(`.modes [data-mode=${m}]`).click(); } catch {}
