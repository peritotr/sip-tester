// Load test report page
(async () => {
  const $ = id => document.getElementById(id);
  const t = (s, p) => I18N.t(s, p);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const N = n => n == null || isNaN(n) ? '—' : (n < 10 && n % 1 ? n.toFixed(1) : Math.round(n).toLocaleString(I18N.locale));
  const MS = n => n == null || isNaN(n) ? '—' : (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString(I18N.locale));
  const PC = n => n == null || isNaN(n) ? '—' : (n > 0 && n < 0.01 ? '<0.01' : n.toFixed(2)) + '%';
  const mmss = s => { s = Math.max(0, Math.round(s || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const dt = ts => ts ? new Date(ts).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const yn = b => b ? t('Yes') : t('No');

  $('lang').value = I18N.lang;
  $('lang').onchange = () => I18N.setLang($('lang').value);
  I18N.apply();

  const id = new URLSearchParams(location.search).get('id');
  let rep = null;
  try { rep = await api.reportGet(id); } catch {}
  if (!rep) { $('report').innerHTML = `<section><h2>${esc(t('Report not found'))}</h2><p class="muted">${esc(t('It may have been deleted.'))}</p></section>`; return; }
  const T = rep.totals || {}, test = rep.test || {}, S = rep.series || [], ev = rep.events || [];
  const L = T.lat || {}, steps = test.steps && test.steps.length, E = T.e2e;
  const TR = E && E.trunks && E.trunks.length > 1 ? E.trunks : null; // several vendor trunks
  const call = (test.scenario || T.scenario) !== 'register' && (test.scenario || T.scenario) !== 'options';
  const sc = test.scenario || T.scenario || 'call';
  const U = call ? 'CPS' : 'RPS';
  let a, title;
  const STEP_STATUS = { ok: 'Clean', latency: 'Latency up', saturated: 'Saturated', warning: '503 / failures / retransmissions', none: '—' };
  const SCEN = { call: 'Call load test', register: 'Registration load test', options: 'OPTIONS load test' };
  const evText = e => e.key ? t(e.key, e.p) : e.text;

  const vendorText = o => [`${o.host}:${o.port}`, o.answerMs ? t('answer {ms} ms', { ms: o.answerMs }) : t('answers at once'),
    o.hangupAfterMs ? t('hangs up after {s} s', { s: o.hangupAfterMs / 1000 }) : null, o.maxCps ? t('limit {n} CPS', { n: o.maxCps }) : null,
    o.maxChannels ? t('{n} channels', { n: o.maxChannels }) : null, o.capacity ? t('capacity {n} CPS', { n: o.capacity }) : null,
    o.busyPct ? t('busy {p}%', { p: o.busyPct }) : null, o.failPct ? t('{code} on {p}%', { code: o.failCode, p: o.failPct }) : null,
    o.echo === false ? t('silent') : t('RTP echo')].filter(Boolean).join(' · ');

  function render() {
  a = SipAnalysis.analyze(rep);
  title = rep.name || (steps ? t('Step test') + ' · ' : '') + t(SCEN[sc]);
  document.title = `${title} — ${dt(rep.createdAt)}`;
  const LAT = call ? t('PDD') : t('Response');

  // ---------- Headline ----------
  let lead;
  if (steps && a.knee && !a.lastGood) lead = t('The server could not handle even the first step (<b>{knee} {unit}</b>).', { knee: N(a.knee.target), unit: U });
  else if (steps && a.knee) lead = a.knee.status === 'saturated'
    ? t('The server ran without a latency increase <b>up to {good} {unit}</b>; it saturated at the <b>{knee} {unit}</b> step.', { good: N(a.lastGood ? a.lastGood.target : 0), knee: N(a.knee.target), unit: U })
    : t('The server ran without a latency increase <b>up to {good} {unit}</b>; latency rose at the <b>{knee} {unit}</b> step.', { good: N(a.lastGood ? a.lastGood.target : 0), knee: N(a.knee.target), unit: U });
  else if (steps) lead = t('The server ran without a latency increase or saturation <b>up to {max} {unit}</b>, the highest load tested.', { max: N(test.steps.at(-1)), unit: U });
  else if (a.onset || a.saturation) lead = t('Target {target} {unit}; the server sustained at most <b>{cap} {unit}</b>', { target: N(test.rate), cap: N(a.capacity && a.capacity.ok), unit: U })
    + (a.onset ? t(', and latency started rising at <b>~{tps} {unit}</b>', { tps: N(a.onset.tps), unit: U }) : '') + '.';
  else lead = t('The server sustained the target <b>{tps} {unit}</b> without issues{dur}; {lat} p95 {p95} ms.', { tps: N(test.rate), unit: U, dur: a.steady ? t(' for {s} s', { s: N(a.steady.minutes * 60) }) : '', lat: LAT, p95: MS(a.steady ? a.steady.p95 : L.p95) });

  const errPct = T.sent ? T.err / T.sent * 100 : 0;
  const verdict = a.verdict === 'pass' ? `<div class="verdict pass">${esc(t('PASSED'))}</div>` : a.verdict === 'fail' ? `<div class="verdict fail">${esc(t('FAILED'))}</div>` : `<div class="verdict none">${esc(t('No criteria'))}</div>`;
  const kpis = [
    [t('Peak capacity'), N(a.capacity && a.capacity.ok), t('{unit} · 10 s avg.', { unit: U })],
    [steps ? t('Latency onset step') : t('Latency onset load'), a.knee ? N(a.knee.target) : a.onset ? '~' + N(a.onset.tps) : t('none'), a.knee || a.onset ? U : ''],
    [call ? t('Peak simultaneous calls') : t('Sustained'), call ? N(T.maxActive) : N(a.steady ? a.steady.ok : null), call ? t('calls') : t('{unit} · steady state', { unit: U })],
    [`${LAT} p50 / p95 / p99`, `${MS(L.p50)} / ${MS(L.p95)} / ${MS(L.p99)}`, 'ms'],
    E ? [t('Routing delay p95 (PBX)'), MS(E.lat && E.lat.p95), t('ms · {pct} reached the vendor', { pct: E.sent ? PC(E.reached / E.sent * 100) : '—' })] : [t('Baseline latency (p95)'), MS(a.baseline && a.baseline.p95), t('ms · at low load')],
    call ? ['ASR', PC(T.asr), `${N(T.ok)} / ${N(T.sent)}`] : [t('Failure rate'), errPct.toFixed(errPct < 0.01 ? 3 : 2) + '%', `${N(T.err)} / ${N(T.sent)}`],
    call ? [t('Failure rate'), errPct.toFixed(errPct < 0.01 ? 3 : 2) + '%', `${N(T.err)} / ${N(T.sent)}`] : [t('Auth challenges'), N(T.challenges), ''],
    call ? [t('RTP loss · jitter p95'), T.rtpCalls ? `${PC(T.rtpLossPct)} · ${MS(T.jitter && T.jitter.p95)} ms` : '—', T.rtpCalls ? t('{n} calls with media', { n: N(T.rtpCalls) }) : t('not measured')]
      : [t('Retransmissions'), N(T.retrans), T.sent ? PC(T.retrans / T.sent * 100) : ''],
  ];

  let html = `
  <section>
    <div class="head">
      <div><h1>${esc(title)}</h1>
        <div class="meta">${dt(rep.startedAt || rep.createdAt)} · ${N(T.secs)} s · ${esc(rep.cfg && rep.cfg.host)}:${esc(rep.cfg && rep.cfg.port)} · ${esc((rep.cfg && rep.cfg.transport || 'udp').toUpperCase())}${rep.cfg && rep.cfg.user ? ' · ' + esc(rep.cfg.user) : ''}</div></div>
      ${verdict}
    </div>
    <p class="lead">${lead}</p>
    <div class="kpis">${kpis.map(k => `<div class="kpi"><span>${esc(k[0])}</span><b>${k[1]}</b><i>${esc(k[2])}</i></div>`).join('')}</div>
  </section>
  <section><h2>${esc(t('Findings'))}</h2><ul class="findings">${a.findings.map(f => `<li><span class="dot ${f.level}"></span><span>${esc(f.text)}</span></li>`).join('')}</ul></section>`;

  if (a.criteria.length) html += `<section><h2>${esc(t('Acceptance criteria'))}</h2><table><thead><tr><th>${esc(t('Criterion'))}</th><th>${esc(t('Limit'))}</th><th>${esc(t('Measured'))}</th><th>${esc(t('Result'))}</th></tr></thead><tbody>
    ${a.criteria.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.lim)}</td><td class="mono">${esc(c.val)}</td><td class="${c.ok ? 'ok' : 'err'}"><b>${esc(c.ok ? t('Passed') : t('Failed'))}</b></td></tr>`).join('')}</tbody></table></section>`;

  html += `
  <section><h2>${esc(t('Load: target vs. actual ({unit})', { unit: U }))}</h2><div class="legend" id="lg1"></div><div class="chart"><canvas id="c1"></canvas></div>
    <p class="note">${esc(t('Vertical lines: {steps}latency onset (yellow), saturation (red), connection drops.', { steps: steps ? t('step changes (thin), ') : '' }))}</p></section>
  <section><h2>${esc(call ? t('Setup latency: post-dial delay (INVITE → 180/183)') : t('Response latency'))}</h2><div class="legend" id="lg2"></div><div class="chart"><canvas id="c2"></canvas></div>
    <p class="note">${esc(t('Dotted line: baseline p95 at low load ({ms} ms).', { ms: MS(a.baseline && a.baseline.p95) }))} ${test.criteria && test.criteria.p95Max ? esc(t('Dashed red: acceptance limit ({ms} ms).', { ms: test.criteria.p95Max })) : ''}</p></section>
  ${call ? `<section><h2>${esc(t('Simultaneous calls'))}</h2><div class="legend" id="lg4"></div><div class="chart"><canvas id="c4"></canvas></div></section>` : ''}
  ${call && T.rtpCalls ? `<section><h2>${esc(t('Media quality'))}</h2><div class="legend" id="lg5"></div><div class="chart"><canvas id="c5"></canvas></div>
    <p class="note">${esc(t('Measured on calls that send RTP. Echo round trip appears when the extension sends our packets back (echo test).'))}</p></section>` : ''}
  <section><h2>${esc(t('Latency vs. load'))}</h2><div class="legend" id="lg3"></div><div class="chart"><canvas id="c3"></canvas></div>
    <p class="note">${esc(t('Each dot is one second: rate on the x axis, p95 latency on the y axis. Where the curve bends is the load at which the server starts adding latency'))}${a.onset ? ` (~${N(a.onset.tps)} ${U})` : ''}.</p></section>`;

  if (a.steps) html += `<section><h2>${esc(t('Steps'))}</h2><table><thead><tr><th>#</th><th class="n">${esc(t('Target'))}</th><th class="n">${esc(t('Sent'))}</th><th class="n">${esc(call ? t('Answered') : t('OK'))}</th><th class="n">p50 ms</th><th class="n">p95 ms</th><th class="n">p99 ms</th>${E ? `<th class="n">${esc(t('Routing p95'))}</th>` : ''}${TR ? `<th class="n">${esc(t('Failover'))}</th>` : ''}${call ? `<th class="n">${esc(t('Active'))}</th>` : ''}<th class="n">503</th><th class="n">${esc(t('Failed'))}</th><th class="n">${esc(t('Retr.'))}</th>${call && T.rtpCalls ? `<th class="n">${esc(t('RTP loss'))}</th>` : ''}<th>${esc(t('Status'))}</th></tr></thead><tbody>
    ${a.steps.map(s => `<tr class="st-${s.status}"><td>${s.step}</td><td class="n">${N(s.target)}</td><td class="n">${N(s.sent)}</td><td class="n">${N(s.ok)}</td><td class="n">${MS(s.p50)}</td><td class="n">${MS(s.p95)}</td><td class="n">${MS(s.p99)}</td>${E ? `<td class="n">${MS(s.e2e)}</td>` : ''}${TR ? `<td class="n">${PC(s.fo)}</td>` : ''}${call ? `<td class="n">${N(s.active)}</td>` : ''}<td class="n">${N(s.thr)}</td><td class="n">${N(s.err)}</td><td class="n">${N(s.retr)}</td>${call && T.rtpCalls ? `<td class="n">${PC(s.loss)}</td>` : ''}
      <td class="${s.status === 'ok' ? 'ok' : s.status === 'saturated' ? 'err' : 'warn'}">${esc(t(STEP_STATUS[s.status] || s.status))}</td></tr>`).join('')}</tbody></table>
    <p class="note">${esc(t('The first seconds of each step are excluded as settling time. A step counts as saturated when the successful rate is below 95% of its target.'))}</p></section>`;

  const errRows = Object.entries(T.errs || {}).sort((x, y) => y[1] - x[1]);
  const H = (label, h) => h && h.n ? `<tr><td>${esc(label)}</td><td class="n">${MS(h.p50)} / ${MS(h.p95)} / ${MS(h.p99)} / ${MS(h.max)} ms</td></tr>` : '';
  const allEv = ev.map(e => ({ ...e, txt: evText(e) }))
    .concat(a.onset ? [{ t: a.onset.t, type: 'onset', txt: t('Latency started rising (p95 {ms} ms)', { ms: MS(a.onset.p95) }) }] : [], a.saturation ? [{ t: a.saturation.t, type: 'sat', txt: t('Successful rate fell below the target') }] : [], a.e2eOnset ? [{ t: a.e2eOnset.t, type: 'onset', txt: t('PBX routing delay started rising (p95 {ms} ms)', { ms: MS(a.e2eOnset.p95) }) }] : [], a.foOnset ? [{ t: a.foOnset.t, type: 'throttle', txt: t('Failover to the backup trunk became steady') }] : [])
    .map((e, i) => ({ ...e, i })).sort((x, y) => x.t - y.t || x.i - y.i).slice(0, 300);
  html += `<div class="grid2">
    <section><h2>${esc(t('Counters'))}</h2><table class="kv"><tbody>
      <tr><td>${esc(call ? t('Call attempts (INVITE)') : sc === 'register' ? t('REGISTER sent') : t('OPTIONS sent'))}</td><td class="n">${N(T.sent)}</td></tr>
      <tr><td>${esc(call ? t('Answered (200 OK)') : t('Successful (2xx)'))}</td><td class="n">${N(T.ok)}</td></tr>
      ${call ? `<tr><td>${esc(t('Completed with BYE'))}</td><td class="n">${N(T.completed)}</td></tr>
      <tr><td>${esc(t('Dropped by the server'))}</td><td class="n ${T.dropped ? 'err' : ''}">${N(T.dropped)}</td></tr>
      <tr><td>${esc(t('Unanswered (cancelled)'))}</td><td class="n ${T.noAnswer ? 'warn' : ''}">${N(T.noAnswer)}</td></tr>` : ''}
      ${E ? `<tr><td>${esc(t('Reached the vendor'))}</td><td class="n">${N(E.reached)} / ${N(E.sent)}</td></tr>
      <tr><td>${esc(t('Not reached the vendor'))}</td><td class="n ${E.missing ? 'err' : ''}">${N(E.missing)}</td></tr>
      <tr><td>${esc(t('Duplicates at the vendor'))}</td><td class="n ${E.dup ? 'err' : ''}">${N(E.dup)}</td></tr>
      ${E.unmatched ? `<tr><td>${esc(t('Unknown numbers at the vendor'))}</td><td class="n warn">${N(E.unmatched)}</td></tr>` : ''}
      ${H(t('Routing: INVITE → vendor (p50/p95/p99/max)'), E.lat)}
      ${TR ? TR.map((x, i) => `<tr><td>${esc(t('Trunk {name}: attempts · taken · rejected', { name: 'ABCD'[i] }))}</td><td class="n">${N(x.att)} · ${N(x.acc)} · <span class="${x.rej ? 'warn' : ''}">${N(x.rej)}</span></td></tr>`).join('')
        + `<tr><td>${esc(t('Failovers to another trunk'))}</td><td class="n ${E.failover ? 'warn' : ''}">${N(E.failover)}</td></tr>`
        + `<tr><td>${esc(t('Rejected by all trunks'))}</td><td class="n ${E.allRejected ? 'err' : ''}">${N(E.allRejected)}</td></tr>`
        + H(t('Failover: first trunk → taken (p50/p95/p99/max)'), E.foLat) : ''}` : ''}
      <tr><td>503 Service Unavailable</td><td class="n ${T.throttled ? 'warn' : ''}">${N(T.throttled)}</td></tr>
      <tr><td>${esc(t('Timeouts'))}</td><td class="n ${T.timeouts ? 'err' : ''}">${N(T.timeouts)}</td></tr>
      <tr><td>${esc(t('Retransmissions'))}</td><td class="n">${N(T.retrans)}</td></tr>
      <tr><td>${esc(t('Auth challenges (401/407)'))}</td><td class="n">${N(T.challenges)}</td></tr>
      ${errRows.map(([k, v]) => `<tr><td>&nbsp;&nbsp;${esc(k)}</td><td class="n err">${N(v)}</td></tr>`).join('')}
      ${call ? H(t('INVITE → 100 Trying (p50/p95/p99/max)'), T.t100) + H(t('PDD (p50/p95/p99/max)'), T.lat) + H(t('INVITE → 200 OK (p50/p95/p99/max)'), T.ans) + H(t('BYE → 200 OK (p50/p95/p99/max)'), T.bye) : H(t('Response (p50/p95/p99/max)'), T.lat)}
      ${call && T.rtpCalls ? `<tr><td>${esc(t('RTP packets sent / received'))}</td><td class="n">${N(T.rtpTx)} / ${N(T.rtpRx)}</td></tr>
      <tr><td>${esc(t('RTP lost / loss'))}</td><td class="n">${N(T.rtpLost)} / ${PC(T.rtpLossPct)}</td></tr>
      ${H(t('Jitter per call (p50/p95/p99/max)'), T.jitter)}${H(t('Echo round trip (p50/p95/p99/max)'), T.rtt)}
      <tr><td>${esc(t('Answered calls without audio'))}</td><td class="n ${T.noMedia ? 'warn' : ''}">${N(T.noMedia)}</td></tr>` : ''}
    </tbody></table></section>
    <section><h2>${esc(t('Events'))}</h2><table><tbody>
      ${allEv.map(e => `<tr><td class="mono" style="width:60px">${mmss(e.t)}</td><td class="${['session', 'error', 'timeout', 'sat', 'drop'].includes(e.type) ? 'err' : ['throttle', 'onset'].includes(e.type) ? 'warn' : ''}">${esc(e.txt)}</td></tr>`).join('') || `<tr><td class="muted">${esc(t('No events'))}</td></tr>`}
    </tbody></table></section>
  </div>
  <section><h2>${esc(t('Test settings'))}</h2><div class="grid2"><table class="kv"><tbody>
      <tr><td>${esc(t('Scenario'))}</td><td>${esc(t(SCEN[sc]))}</td></tr>
      <tr><td>${esc(t('Test type'))}</td><td>${esc(steps ? t('Step: {from} → {to} {unit}, {n} steps × {s} s', { from: N(test.steps[0]), to: N(test.steps.at(-1)), unit: U, n: test.steps.length, s: test.stepDur }) : t('Constant: {tps} {unit}, {amount}', { tps: N(test.rate), unit: U, amount: test.total ? N(test.total) + ' ' + t(call ? 'calls' : 'requests') : N(test.duration) + ' s' }))}</td></tr>
      <tr><td>${esc(call ? t('Max concurrent calls') : t('Max requests in flight'))}</td><td>${N(test.concurrent)}</td></tr>
      <tr><td>${esc(t('Sockets / connections'))}</td><td>${N(test.connections)}</td></tr>
      <tr><td>Ramp-up</td><td>${test.ramp || 0} s</td></tr>
      <tr><td>${esc(t('Response limit'))}</td><td>${test.respTimeout} s</td></tr>
      <tr><td>${esc(t('Slow down on 503'))} / ${esc(t('Reuse nonce'))}</td><td>${yn(test.backoff503)} / ${yn(test.reuseNonce)}</td></tr>
    </tbody></table><table class="kv"><tbody>
      <tr><td>${esc(t('Server'))}</td><td>${esc(rep.cfg && rep.cfg.host)}:${esc(rep.cfg && rep.cfg.port)} · ${esc((rep.cfg && rep.cfg.transport || 'udp').toUpperCase())}</td></tr>
      ${call ? `<tr><td>${esc(t('Destination'))}</td><td>${esc(test.dst)}</td></tr>
      <tr><td>${esc(t('Hold time'))} / ${esc(t('Max ring'))}</td><td>${test.holdMin}–${test.holdMax} s / ${test.maxRing} s</td></tr>
      <tr><td>RTP</td><td>${test.rtp ? t('on, up to {n} calls · {codec}', { n: N(test.rtpMax), codec: test.codec }) : t('off')}</td></tr>` : ''}
      ${sc === 'register' ? `<tr><td>${esc(t('Expiry'))}</td><td>${test.expires} s</td></tr>` : ''}
      <tr><td>${esc(t('Accounts'))}</td><td>${esc(test.users || (rep.cfg && rep.cfg.user) || '—')}</td></tr>
      ${rep.vendor && rep.vendor.opts ? (rep.vendor.opts.trunks && rep.vendor.opts.trunks.length > 1
        ? rep.vendor.opts.trunks.map((x, i) => `<tr><td>${esc(t('Vendor trunk {name}', { name: 'ABCD'[i] }))}</td><td>${esc(vendorText({ ...x, host: rep.vendor.opts.host }))}</td></tr>`).join('')
        : `<tr><td>${esc(t('Vendor'))}</td><td>${esc(vendorText(rep.vendor.opts))}</td></tr>`) : ''}
      ${E ? `<tr><td>${esc(t('End-to-end'))}</td><td>${esc(t('call number in the last {k} digits', { k: E.digits }))}</td></tr>` : ''}
    </tbody></table></div>
    <p class="note">${esc(t('Latency onset: p95 exceeding 2× the low-load baseline (at least +20 ms){crit} for 3 consecutive seconds. Saturation: the successful rate staying below 90% of the target for 3 seconds.', { crit: test.criteria && test.criteria.p95Max ? t(' or the acceptance limit') : '' }))}</p>
  </section>`;
  $('report').innerHTML = html;
  }
  render();

  // ---------- Charts ----------
  function chart(cv, o) {
    if (!cv) return;
    const dpr = Math.max(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const Lm = 56, R = 14, Tm = 14, B = 26, w = W - Lm - R, h = H - Tm - B;
    const xs = o.xMin, xe = o.xMax;
    let ymax = o.yMax || 0, ymin = o.yLog ? Infinity : 0;
    for (const s of o.series) for (const v of s.y) if (v != null && !isNaN(v)) { if (v > ymax) ymax = v; if (o.yLog && v > 0 && v < ymin) ymin = v; }
    for (const p of o.points || []) { if (p.y > ymax) ymax = p.y; if (o.yLog && p.y > 0 && p.y < ymin) ymin = p.y; }
    for (const r of o.hrefs || []) if (r.y > ymax) ymax = r.y;
    if (!ymax) ymax = 1;
    let Y, ticks;
    if (o.yLog) {
      ymin = Math.pow(10, Math.floor(Math.log10(Math.max(ymin === Infinity ? 1 : ymin, 0.1)))); ymax = Math.pow(10, Math.ceil(Math.log10(ymax)));
      Y = v => Tm + h - (Math.log10(Math.max(v, ymin)) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin)) * h;
      ticks = []; for (let v = ymin; v <= ymax * 1.001; v *= 10) { ticks.push(v); if (v * 3 < ymax) ticks.push(v * 3); }
    } else {
      const raw = ymax * 1.08 / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const st = [1, 2, 2.5, 5, 10].find(m => m * mag >= raw) * mag; ymax = st * 4;
      Y = v => Tm + h - v / ymax * h; ticks = [0, st, 2 * st, 3 * st, 4 * st];
    }
    const X = v => Lm + (v - xs) / ((xe - xs) || 1) * w;
    g.font = '11px -apple-system, sans-serif'; g.lineWidth = 1;
    for (const v of ticks) {
      const yy = Math.round(Y(v)) + .5; g.strokeStyle = css('--grid'); g.beginPath(); g.moveTo(Lm, yy); g.lineTo(Lm + w, yy); g.stroke();
      g.fillStyle = css('--muted'); g.textAlign = 'right'; g.fillText(o.yFmt(v), Lm - 7, yy + 3.5);
    }
    g.textAlign = 'center';
    const xt = o.xTicks || 8;
    for (let i = 0; i <= xt; i++) { const v = xs + (xe - xs) * i / xt; g.fillText(o.xFmt(v), X(v), H - 7); }
    for (const m of o.vbands || []) { g.strokeStyle = css('--grid'); g.lineWidth = 1; g.beginPath(); g.moveTo(X(m.x), Tm); g.lineTo(X(m.x), Tm + h); g.stroke(); if (m.label) { g.fillStyle = css('--muted'); g.font = '10px -apple-system, sans-serif'; g.textAlign = 'left'; g.fillText(m.label, X(m.x) + 3, Tm + 9); } }
    for (const r of o.hrefs || []) { g.strokeStyle = css(r.color); g.setLineDash(r.dash || [4, 4]); g.lineWidth = 1.25; g.beginPath(); g.moveTo(Lm, Y(r.y)); g.lineTo(Lm + w, Y(r.y)); g.stroke(); g.setLineDash([]); }
    for (const p of o.points || []) { g.fillStyle = css(p.color); g.globalAlpha = p.alpha ?? 0.35; g.beginPath(); g.arc(X(p.x), Y(p.y), 2.2, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
    g.lineJoin = 'round';
    for (const s of o.series) {
      if (!s.y.some(v => v != null && v > 0)) continue;
      g.strokeStyle = css(s.color); g.lineWidth = s.width || 2; g.setLineDash(s.dash || []); g.beginPath(); let on = false;
      s.y.forEach((v, i) => { if (v == null || isNaN(v)) { on = false; return; } const x = X(s.x ? s.x[i] : o.x[i]), y = Y(o.yLog ? Math.max(v, ymin) : v); on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; });
      g.stroke(); g.setLineDash([]);
    }
    for (const m of o.vmarks || []) {
      const x = X(m.x); g.strokeStyle = css(m.color); g.lineWidth = 1.5; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(x, Tm); g.lineTo(x, Tm + h); g.stroke(); g.setLineDash([]);
      if (m.label) { g.font = '600 11px -apple-system, sans-serif'; g.fillStyle = css(m.color); const tw = g.measureText(m.label).width; const right = x + 6 + tw > Lm + w; g.textAlign = right ? 'right' : 'left'; g.fillText(m.label, right ? x - 6 : x + 6, Tm + 22 + (m.row || 0) * 14); }
    }
  }
  const legend = (el, items) => { if (el) el.innerHTML = items.map(i => `<span><i class="${i.dash ? 'dash' : ''}" style="background:${css(i.color)};color:${css(i.color)}"></i>${esc(i.label)}</span>`).join(''); };

  const rows = S.filter(r => r && r.t != null);
  const tx = rows.map(r => r.t), tMax = Math.max(1, ...tx);
  const stepMarks = []; if (steps) { let prev = null; for (const r of rows) if (r.step && r.step !== prev) { stepMarks.push({ x: r.t, label: N(test.steps[r.step - 1]) }); prev = r.step; } }
  const kfmt = v => v >= 1000 ? (v / 1000).toLocaleString(I18N.locale, { maximumFractionDigits: 1 }) + 'k' : (v < 10 && v % 1 ? v.toFixed(1) : String(Math.round(v)));

  function drawAll() {
    if (!rows.length) return;
    const marks = [];
    if (a.onset) marks.push({ x: a.onset.t, color: '--warn', label: t('Latency onset · ~{tps} {unit}', { tps: N(a.onset.tps), unit: U }), row: 0 });
    if (a.e2eOnset) marks.push({ x: a.e2eOnset.t, color: '--accent', label: t('Routing delay up · ~{tps} {unit}', { tps: N(a.e2eOnset.tps), unit: U }), row: 2 });
    if (a.foOnset) marks.push({ x: a.foOnset.t, color: '--accent', label: t('Failover · ~{tps} {unit}', { tps: N(a.foOnset.tps), unit: U }), row: 3 });
    if (a.saturation) marks.push({ x: a.saturation.t, color: '--err', label: t('Saturation · {tps} {unit}', { tps: N(a.saturation.ok), unit: U }), row: 1 });
    for (const e of ev.filter(e => e.type === 'session').slice(0, 10)) marks.push({ x: e.t, color: '--err' });
    const s1 = [
      { y: rows.map(r => r.target), color: '--muted', width: 1.5, dash: [5, 4], label: t('Target') },
      { y: rows.map(r => r.sentTps), color: '--accent', width: 1.5, label: call ? t('Attempts') : t('Sent') },
      { y: rows.map(r => r.okTps), color: '--ok', width: 2.25, label: call ? t('Answered') : t('OK') },
      { y: rows.map(r => r.thrTps), color: '--warn', width: 1.5, label: '503' },
      { y: rows.map(r => r.errTps), color: '--err', width: 1.5, label: t('Failed') },
      { y: rows.map(r => r.retrTps), color: '--violet', width: 1.25, label: t('Retransmissions') },
      ...(TR ? [{ y: rows.map(r => r.e2eFoTps), color: '--accent', width: 1.5, dash: [3, 3], label: t('Failovers') }] : []),
    ];
    chart($('c1'), { x: tx, xMin: 0, xMax: tMax, series: s1, vmarks: marks, vbands: stepMarks, yFmt: kfmt, xFmt: mmss });
    legend($('lg1'), s1.filter(s => s.y.some(v => v > 0)));

    const lat = Math.max(...rows.map(r => r.p99 || 0)), base = a.baseline && a.baseline.p95 || 1;
    const yLog = lat / base > 30;
    const s2 = [
      { y: rows.map(r => r.p50), color: '--ok', width: 1.75, label: 'p50' },
      { y: rows.map(r => r.p95), color: '--warn', width: 2.25, label: 'p95' },
      { y: rows.map(r => r.p99), color: '--err', width: 1.5, label: 'p99' },
      ...(call ? [{ y: rows.map(r => r.t100P95), color: '--violet', width: 1.5, label: t('100 Trying p95') }] : []),
      ...(E ? [{ y: rows.map(r => r.e2eP95), color: '--accent', width: 1.75, label: t('Routing p95') }] : []),
    ];
    const hrefs = [];
    if (a.baseline && a.baseline.p95) hrefs.push({ y: a.baseline.p95, color: '--muted', dash: [2, 3] });
    if (test.criteria && test.criteria.p95Max) hrefs.push({ y: test.criteria.p95Max, color: '--err', dash: [6, 4] });
    chart($('c2'), { x: tx, xMin: 0, xMax: tMax, series: s2, hrefs, vmarks: marks.filter(m => m.label), vbands: stepMarks, yLog, yFmt: v => MS(v), xFmt: mmss });
    legend($('lg2'), s2.filter(s => s.y.some(v => v > 0)).concat(yLog ? [{ label: t('log scale'), color: '--muted', dash: true }] : []));

    if (call) {
      const s4 = [{ y: rows.map(r => r.inflight), color: '--accent', width: 2, label: t('Active calls') }, { y: rows.map(r => r.rtpCalls), color: '--violet', width: 1.5, label: t('With RTP') },
        { y: rows.map(r => r.dropTps), color: '--err', width: 1.5, label: t('Dropped / s') }];
      chart($('c4'), { x: tx, xMin: 0, xMax: tMax, series: s4, vbands: stepMarks, vmarks: marks.filter(m => !m.label), yFmt: kfmt, xFmt: mmss });
      legend($('lg4'), s4.filter(s => s.y.some(v => v > 0)));
      if (T.rtpCalls) {
        const s5 = [{ y: rows.map(r => r.rtpLoss), color: '--err', width: 2, label: t('Loss %') }, { y: rows.map(r => r.jitter), color: '--warn', width: 1.75, label: t('Jitter ms') }, { y: rows.map(r => r.rttP95), color: '--violet', width: 1.5, label: t('Echo RTT p95 ms') }];
        chart($('c5'), { x: tx, xMin: 0, xMax: tMax, series: s5, vbands: stepMarks, yFmt: v => MS(v), xFmt: mmss });
        legend($('lg5'), s5.filter(s => s.y.some(v => v > 0)));
      }
    }

    const pts = rows.filter(r => r.p95 != null && r.sentTps > 0);
    const xMax3 = Math.max(1, ...pts.map(r => r.sentTps));
    const lim = a.onset ? a.onset.limit : null;
    const c3 = {
      x: a.curve.map(c => c.tps), xMin: 0, xMax: xMax3 * 1.05, xTicks: 6,
      points: pts.map(r => ({ x: r.sentTps, y: r.p95, color: lim && r.p95 > lim ? '--err' : '--accent', alpha: 0.35 })),
      series: [{ y: a.curve.map(c => c.p95), color: '--warn', width: 2.25, label: t('p95 (median)') }, { y: a.curve.map(c => c.p99), color: '--err', width: 1.5, label: t('p99 (median)') }],
      vmarks: a.onset ? [{ x: a.onset.tps, color: '--warn', label: t('Latency onset · ~{tps} {unit}', { tps: N(a.onset.tps), unit: U }) }] : [],
      hrefs: a.baseline && a.baseline.p95 ? [{ y: a.baseline.p95, color: '--muted', dash: [2, 3] }] : [],
      yLog, yFmt: v => MS(v), xFmt: kfmt,
    };
    chart($('c3'), c3);
    legend($('lg3'), [{ label: t('p95 per second'), color: '--accent' }].concat(c3.series.filter(s => s.y.some(v => v > 0))));
  }
  drawAll();
  window.addEventListener('resize', drawAll);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawAll);

  // ---------- Export ----------
  const fname = ext => `sip-report-${(rep.name || rep.id).replace(/[^\w.-]+/g, '_')}.${ext}`;
  const download = (text, name, type) => {
    if (api.saveFile && !api.web) return api.saveFile(text, name);
    const el = document.createElement('a'); el.href = URL.createObjectURL(new Blob([text], { type })); el.download = name; document.body.appendChild(el); el.click(); el.remove();
  };
  $('bJson').onclick = () => download(JSON.stringify(rep, null, 1), fname('json'), 'application/json');
  $('bCsv').onclick = () => {
    const tr = I18N.lang === 'tr', sep = tr ? ';' : ',', dec = tr ? ',' : '.';
    const cols = ['t', 'step', 'target', 'sentTps', 'okTps', 'errTps', 'thrTps', 'toTps', 'retrTps', 'inflight', 'windowFull', 'bound', 'p50', 'p95', 'p99', 'max', 'ansP95', 't100P95', 'byeTps', 'dropTps', 'rtpCalls', 'rtpLoss', 'jitter', 'rttP95', 'e2eRxTps', 'e2eP50', 'e2eP95', 'e2eP99', ...(TR ? ['e2eFoTps'] : [])];
    const head = ['second', 'step', 'target', 'sent_ps', 'ok_ps', 'failed_ps', '503_ps', 'timeout_ps', 'retrans_ps', 'active', 'limit_full_ratio', 'connections', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'answer_p95_ms', 'trying_p95_ms', 'bye_ps', 'dropped_ps', 'rtp_calls', 'rtp_loss_pct', 'jitter_ms', 'echo_rtt_p95_ms', 'vendor_rx_ps', 'routing_p50_ms', 'routing_p95_ms', 'routing_p99_ms', ...(TR ? ['failover_ps', ...TR.map((_, i) => `trunk_${'abcd'[i]}_taken_ps`)] : [])];
    const f = v => v == null || isNaN(v) ? '' : (Number.isInteger(v) ? String(v) : v.toFixed(2)).replace('.', dec);
    const clean = s => String(s).replace(new RegExp(sep, 'g'), ' ');
    const lvl = { ok: 'OK', warn: t('WARNING'), bad: t('ISSUE') };
    const lines = [`# ${clean(title)}${sep}${dt(rep.createdAt)}`, ...a.findings.map(x => `# ${lvl[x.level]}${sep}${clean(x.text)}`), '', head.join(sep), ...rows.map(r => cols.map(c => f(r[c])).concat(TR ? TR.map((_, i) => f(r.e2eTr ? r.e2eTr[i] : null)) : []).join(sep))];
    download('﻿' + lines.join('\n'), fname('csv'), 'text/csv;charset=utf-8');
  };
  $('bPdf').onclick = async () => {
    document.documentElement.classList.add('print'); drawAll();
    try { if (api.reportPdf) await api.reportPdf(fname('pdf')); else { await new Promise(r => setTimeout(r, 50)); window.print(); } }
    finally { document.documentElement.classList.remove('print'); drawAll(); }
  };
  window.addEventListener('beforeprint', () => { document.documentElement.classList.add('print'); drawAll(); });
  window.addEventListener('afterprint', () => { document.documentElement.classList.remove('print'); drawAll(); });
  I18N.onChange(() => { render(); drawAll(); });
})();
