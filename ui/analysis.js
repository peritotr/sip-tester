// Load test performance analysis. The same code runs in the browser (report page) and in Node (archive summary).
// Input: report { test, series[], events[], totals }. Draws conclusions from per-second rows.
// "Rate" is calls per second (call scenario) or requests per second (registrations, OPTIONS);
// "latency" is PDD for calls (INVITE → first 180/183, or 200) and the final response time otherwise.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SipAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const fill = (s, p) => p ? String(s).replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : String(s);
  const t = (s, p) => (typeof I18N !== 'undefined' ? I18N.t(s, p) : fill(s, p));
  const locale = () => (typeof I18N !== 'undefined' ? I18N.locale : 'en-US');
  const median = a => { const v = a.filter(x => x != null && !isNaN(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const mean = a => { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const maxOf = a => { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? Math.max(...v) : null; };
  const sum = a => a.reduce((s, x) => s + (x || 0), 0);
  const pctOf = (a, b) => b > 0 ? a / b * 100 : null;
  const r0 = n => n == null ? '—' : (n < 10 && n % 1 ? n.toFixed(1) : Math.round(n).toLocaleString(locale()));
  const r1 = n => n == null ? '—' : (n < 10 ? n.toFixed(1) : Math.round(n).toString());
  const pc = n => n == null ? '—' : (n > 0 && n < 0.01 ? '<0.01' : n.toFixed(2));
  const mmss = s => { s = Math.max(0, Math.round(s)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

  function firstSustained(rows, cond, need) {
    let run = 0;
    for (let i = 0; i < rows.length; i++) { if (cond(rows[i], i)) { if (++run >= need) return i - need + 1; } else run = 0; }
    return -1;
  }
  function linreg(xs, ys) {
    const n = xs.length; if (n < 5) return null;
    const mx = mean(xs), my = mean(ys); let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    return den ? num / den : null;
  }

  function analyze(rep) {
    const test = rep.test || {}, T = rep.totals || {}, crit = test.criteria || {};
    const scenario = test.scenario || T.scenario || 'call', call = scenario === 'call';
    const U = call ? 'CPS' : 'RPS';
    const all = (rep.series || []).filter(r => r && r.t != null);
    const active = all.filter(r => r.sentTps > 0 || r.target > 0);
    const out = { scenario, unit: U, findings: [], criteria: [], steps: null, curve: [], baseline: null, onset: null, e2eOnset: null, foOnset: null, saturation: null, capacity: null, steady: null };
    if (!active.length) { out.findings.push({ level: 'bad', text: t('Nothing was sent during the test; there is no data to analyse.') }); return out; }
    const target = Number(test.rate || test.tps) || maxOf(active.map(r => r.target)) || 0;
    // Answers lag attempts by the ring time: compare the answered rate with the target after that delay
    const lag = call ? Math.max(0, Math.round(((T.ans && T.ans.p50) || 0) / 1000)) : 0;
    const okAt = i => { const r = active[Math.min(active.length - 1, i + lag)]; return r ? r.okTps : null; };

    // ---------- Baseline latency: the first, lightly loaded seconds ----------
    const lowLoad = active.filter(r => r.p95 != null && r.sentTps > 0);
    const firstN = lowLoad.slice(0, Math.max(5, Math.ceil(lowLoad.length * 0.15)));
    const baseRows = test.steps ? lowLoad.filter(r => r.step === 1).slice(2) : firstN.slice(1);
    const baseSrc = baseRows.length >= 3 ? baseRows : firstN;
    const hasE2e = !!T.e2e && active.some(r => r.e2eP95 != null);
    const base = { p50: median(baseSrc.map(r => r.p50)), p95: median(baseSrc.map(r => r.p95)), p99: median(baseSrc.map(r => r.p99)), e2eP95: hasE2e ? median(baseSrc.map(r => r.e2eP95)) : null };
    out.baseline = base;
    const thr = b => b == null ? null : Math.max(b * 2, b + 20);
    const p95Lim = crit.p95Max ? Math.min(thr(base.p95) ?? Infinity, Number(crit.p95Max)) : thr(base.p95);
    const scan = active.slice(Math.min(3, Math.max(0, active.length - 3)));

    // ---------- Latency onset ----------
    if (p95Lim != null) {
      const i = firstSustained(scan, r => r.p95 != null && r.p95 > p95Lim, 3);
      if (i >= 0) { const r = scan[i], win = scan.slice(Math.max(0, i - 3), i); out.onset = { t: r.t, tps: median(win.map(x => x.sentTps)) ?? r.sentTps, target: r.target, p95: r.p95, base: base.p95, limit: p95Lim, step: r.step }; }
    }

    // PBX routing delay (client INVITE → vendor INVITE) onset
    if (hasE2e && base.e2eP95 != null) {
      const lim = crit.e2eP95Max ? Math.min(thr(base.e2eP95), Number(crit.e2eP95Max)) : thr(base.e2eP95);
      const i = firstSustained(scan, r => r.e2eP95 != null && r.e2eP95 > lim, 3);
      if (i >= 0) { const r = scan[i]; out.e2eOnset = { t: r.t, tps: r.sentTps, p95: r.e2eP95, base: base.e2eP95, limit: lim, step: r.step }; }
    }
    // Several trunks: when the PBX started failing calls over to a backup trunk (sustained, not a one-off)
    const hasFo = hasE2e && active.some(r => r.e2eFoTps != null);
    if (hasFo) {
      const i = firstSustained(active, r => r.e2eFoTps > 0 && r.e2eRxTps > 0 && r.e2eFoTps / r.e2eRxTps >= 0.01, 3);
      if (i >= 0) { const r = active[i]; out.foOnset = { t: r.t, tps: test.steps && r.step ? test.steps[r.step - 1] : r.sentTps, step: r.step }; } // the load it started at
    }

    // ---------- Saturation: successful rate stays below 90% of a flat target ----------
    const sendRows = active.filter(r => r.target > 0);
    const stable = (r, i, arr) => i > 0 && Math.abs(r.target - arr[i - 1].target) <= Math.max(0.5, r.target * 0.02);
    const idx = new Map(active.map((r, i) => [r, i]));
    const okOf = r => okAt(idx.get(r));
    const sr1 = sendRows.slice(1 + lag);
    const si = firstSustained(sr1, (r, i) => stable(r, i, sr1) && okOf(r) != null && okOf(r) < 0.9 * r.target && r.target >= 1, 3);
    if (si >= 0) {
      const r = sr1[si], win = sr1.slice(si, si + 5);
      const thrS = sum(win.map(x => x.thrTps)), wf = mean(win.map(x => x.windowFull)), lost = win.some(x => x.bound != null && x.bound < (test.connections || 1));
      const toS = sum(win.map(x => x.toTps)), errS = sum(win.map(x => x.errTps)), retr = sum(win.map(x => x.retrTps));
      let cause;
      if (thrS > 0 && thrS >= errS * 0.5) cause = 'throttle';
      else if (lost) cause = 'sessions';
      else if (toS > 0 && toS >= errS * 0.5) cause = 'timeouts';
      else if (wf > 0.3) cause = 'backpressure';
      else if (errS > 0) cause = 'errors';
      else if (retr > 0) cause = 'timeouts';
      else cause = 'client';
      out.saturation = { t: r.t, ok: median(win.map(okOf)), target: r.target, cause, step: r.step };
    }

    // ---------- Capacity: best 10-second average of the successful rate ----------
    let best = null;
    for (let i = 0; i + 10 <= active.length; i++) {
      const w = active.slice(i, i + 10), ok = mean(w.map(r => r.okTps));
      if (!best || ok > best.ok) best = { ok, t: w[0].t, p95: median(w.map(r => r.p95)) };
    }
    if (!best) best = { ok: maxOf(active.map(r => r.okTps)), t: active[0].t, p95: median(active.map(r => r.p95)) };
    out.capacity = best;

    // ---------- Steady state ----------
    const full = sendRows.filter(r => r.target >= target * 0.99 && !(test.steps && r.step && r.step < (test.steps.length || 0)));
    const steadyRows = (full.length >= 5 ? full.slice(2 + lag) : sendRows.slice(Math.min(3, sendRows.length - 1)));
    if (steadyRows.length >= 3) {
      const oks = steadyRows.map(r => r.okTps), m = mean(oks), sd = Math.sqrt(mean(oks.map(x => (x - m) ** 2)));
      const slope = linreg(steadyRows.map(r => r.t / 60), steadyRows.map(r => r.p95 ?? 0));
      out.steady = { from: steadyRows[0].t, to: steadyRows.at(-1).t, ok: m, cv: m ? sd / m * 100 : 0, p50: median(steadyRows.map(r => r.p50)), p95: median(steadyRows.map(r => r.p95)), p99: median(steadyRows.map(r => r.p99)),
        active: median(steadyRows.map(r => r.inflight)), driftPerMin: slope, minutes: (steadyRows.at(-1).t - steadyRows[0].t) / 60,
        p95First: median(steadyRows.slice(0, Math.max(3, steadyRows.length >> 3)).map(r => r.p95)), p95Last: median(steadyRows.slice(-Math.max(3, steadyRows.length >> 3)).map(r => r.p95)) };
    }

    // ---------- Step table ----------
    if (test.steps && test.steps.length) {
      out.steps = test.steps.map((tgt, k) => {
        const rows = sendRows.filter(r => r.step === k + 1);
        const settled = rows.length > 4 + lag ? rows.slice(2 + lag) : rows.length > 1 ? rows.slice(1) : rows;
        const sent = median(settled.map(r => r.sentTps)), ok = median(settled.map(r => r.okTps)), p95 = median(settled.map(r => r.p95)), p99 = maxOf(settled.map(r => r.p99));
        const thrN = sum(rows.map(r => r.thrTps)), errN = sum(rows.map(r => r.errTps)), retrN = sum(rows.map(r => r.retrTps)), wf = mean(rows.map(r => r.windowFull));
        let status = 'ok';
        if (!rows.length) status = 'none';
        else if (ok != null && ok < 0.95 * tgt) status = 'saturated';
        else if (p95 != null && p95Lim != null && p95 > p95Lim) status = 'latency';
        else if (thrN > 0 || errN > 0 || retrN > 0) status = 'warning';
        return { step: k + 1, target: tgt, sent, ok, p50: median(settled.map(r => r.p50)), p95, p99, active: median(settled.map(r => r.inflight)), thr: thrN, err: errN, retr: retrN, windowFull: wf,
          loss: call ? mean(settled.map(r => r.rtpLoss)) : null, e2e: hasE2e ? median(settled.map(r => r.e2eP95)) : null,
          fo: hasFo ? pctOf(sum(rows.map(r => r.e2eFoTps)), sum(rows.map(r => r.e2eRxTps))) : null, status };
      });
      const knee = out.steps.find(s => s.status === 'latency' || s.status === 'saturated');
      const lastGood = [...out.steps].reverse().find(s => s.status === 'ok' && (!knee || s.step < knee.step));
      out.knee = knee || null; out.lastGood = lastGood || null;
    }

    // ---------- Latency vs. rate ----------
    const mx = maxOf(active.map(r => r.sentTps)) || 0;
    if (mx > 0) {
      const nb = 12, w = mx / nb;
      for (let b = 0; b < nb; b++) {
        const rows = active.filter(r => r.sentTps > b * w && r.sentTps <= (b + 1) * w + 1e-9 && r.p95 != null);
        if (rows.length) out.curve.push({ tps: median(rows.map(r => r.sentTps)), p50: median(rows.map(r => r.p50)), p95: median(rows.map(r => r.p95)), p99: median(rows.map(r => r.p99)), n: rows.length });
      }
    }

    // ---------- Acceptance criteria ----------
    const sent = T.sent || 0, errRate = sent ? (T.err || 0) / sent * 100 : 0, L = T.lat || {};
    const add = (name, ok, val, lim) => out.criteria.push({ name, ok, val, lim });
    const LAT = call ? t('PDD') : t('Response');
    if (crit.p95Max) add(`${LAT} p95`, (L.p95 ?? 0) <= crit.p95Max, `${r1(L.p95)} ms`, `≤ ${crit.p95Max} ms`);
    if (crit.p99Max) add(`${LAT} p99`, (L.p99 ?? 0) <= crit.p99Max, `${r1(L.p99)} ms`, `≤ ${crit.p99Max} ms`);
    if (call && crit.asrMin != null && crit.asrMin !== '') add('ASR', (T.asr ?? 0) >= crit.asrMin, `${pc(T.asr)}%`, `≥ ${crit.asrMin}%`);
    if (crit.errMaxPct != null && crit.errMaxPct !== '') add(t('Failure rate'), errRate <= crit.errMaxPct, `${errRate.toFixed(3)}%`, `≤ ${crit.errMaxPct}%`);
    const E = T.e2e, missPct = E && E.sent ? E.missing / E.sent * 100 : null;
    if (E && crit.e2eP95Max && E.lat && E.lat.n) add(t('End-to-end routing p95'), (E.lat.p95 ?? 0) <= crit.e2eP95Max, `${r1(E.lat.p95)} ms`, `≤ ${crit.e2eP95Max} ms`);
    if (E && crit.e2eMissMaxPct != null && crit.e2eMissMaxPct !== '') add(t('Not reached the vendor'), missPct <= crit.e2eMissMaxPct, `${missPct.toFixed(3)}%`, `≤ ${crit.e2eMissMaxPct}%`);
    if (call && crit.rtpLossMaxPct != null && crit.rtpLossMaxPct !== '' && T.rtpLossPct != null) add(t('RTP loss'), T.rtpLossPct <= crit.rtpLossMaxPct, `${pc(T.rtpLossPct)}%`, `≤ ${crit.rtpLossMaxPct}%`);
    if (crit.minTps) { const v = out.steady ? out.steady.ok : best.ok; add(t('Sustained rate'), v >= crit.minTps * 0.98, `${r0(v)} ${U}`, `≥ ${r0(crit.minTps)} ${U}`); }
    out.verdict = out.criteria.length ? (out.criteria.every(c => c.ok) ? 'pass' : 'fail') : null;

    // ---------- Findings ----------
    const F = (level, text) => out.findings.push({ level, text });
    const ev = rep.events || [];
    const CAUSE = {
      throttle: 'overload: the server answered 503 Service Unavailable',
      sessions: 'connection loss: some TCP connections were closed',
      timeouts: 'the server stopped answering in time (timeouts and retransmissions)',
      backpressure: 'the concurrency limit filled up because the server answered slowly',
      errors: 'the server rejected requests with error responses',
      client: 'the test machine could not send at the target rate (CPU or network)',
    };
    if (out.saturation) out.saturation.causeText = t(CAUSE[out.saturation.cause] || out.saturation.cause);
    if (out.steps && out.knee && !out.lastGood) {
      F('bad', out.knee.status === 'saturated'
        ? t('The server saturated already at the first step ({knee} {unit}; successful {ok} {unit}).', { knee: r0(out.knee.target), ok: r0(out.knee.ok), unit: U })
        : t('Latency rose already at the first step ({knee} {unit}; p95 {p95} ms).', { knee: r0(out.knee.target), p95: r1(out.knee.p95), unit: U }));
    } else if (out.steps && out.knee) {
      F('warn', out.knee.status === 'saturated'
        ? t('The server is clean up to {good} {unit}; it saturated at the {knee} {unit} step (successful {ok} {unit}).', { good: r0(out.lastGood ? out.lastGood.target : 0), knee: r0(out.knee.target), ok: r0(out.knee.ok), unit: U })
        : t('The server is clean up to {good} {unit}; latency rose at the {knee} {unit} step (p95 {p95} ms, baseline {base} ms).', { good: r0(out.lastGood ? out.lastGood.target : 0), knee: r0(out.knee.target), p95: r1(out.knee.p95), base: r1(base.p95), unit: U }));
    } else if (out.steps) F('ok', t('All steps (up to {max} {unit}) passed without a latency increase or saturation.', { max: r0(out.steps.at(-1).target), unit: U }));
    if (out.onset) {
      F('warn', t('{what} started rising at {time}, at about {tps} {unit}: p95 went from a {base} ms baseline to {p95} ms', { what: call ? t('Post-dial delay') : t('Response time'), time: mmss(out.onset.t), tps: r0(out.onset.tps), unit: U, base: r1(out.onset.base), p95: r1(out.onset.p95) })
        + (out.onset.step ? ' ' + t('(step {n})', { n: out.onset.step }) : '') + '.');
    } else if (base.p95 != null) F('ok', t('{what} stayed at its baseline throughout the test (p95 ≈ {p95} ms).', { what: call ? t('Post-dial delay') : t('Response time'), p95: r1(base.p95) }));
    if (out.saturation) F('bad', t('At {time} the successful rate fell below the target ({ok} / {target} {unit}). Likely cause: {cause}.', { time: mmss(out.saturation.t), ok: r0(out.saturation.ok), target: r0(out.saturation.target), unit: U, cause: out.saturation.causeText }));
    else if (!out.steps && best.ok >= target * 0.9) F('ok', t('The target rate was reached and held (best 10 s average {tps} {unit}).', { tps: r0(best.ok), unit: U }));
    else if (!out.steps) F('bad', t('The target rate was not reached (best 10 s average {tps} of {target} {unit}).', { tps: r0(best.ok), target: r0(target), unit: U }));
    if (out.steady && out.steady.minutes >= 2 && out.steady.driftPerMin != null) {
      const d = out.steady.driftPerMin, rel = out.steady.p95First ? (out.steady.p95Last - out.steady.p95First) / out.steady.p95First : 0;
      if (d > 0 && rel > 0.5) F('warn', t('Latency grows over time under steady load: p95 rose ~{d} ms per minute ({from} → {to} ms). This may point to a growing queue or a resource leak.', { d: r1(d), from: r1(out.steady.p95First), to: r1(out.steady.p95Last) }));
      else F('ok', t('Latency stayed flat for {min} minutes under steady load.', { min: r1(out.steady.minutes) }));
    }
    if (call) {
      if (T.asr != null) F(T.asr >= 99 ? 'ok' : T.asr >= 90 ? 'warn' : 'bad', t('ASR {asr}%: {ok} of {sent} call attempts were answered.', { asr: pc(T.asr), ok: r0(T.ok), sent: r0(T.sent) }));
      if (out.steady && out.steady.active) F('ok', t('The server held about {n} simultaneous calls at steady state (peak {max}).', { n: r0(out.steady.active), max: r0(T.maxActive) }));
      if (T.dropped) F('bad', t('{n} answered calls were hung up by the server before their hold time ended (first at {time}).', { n: r0(T.dropped), time: mmss((ev.find(e => e.type === 'drop') || {}).t || 0) }));
      if (T.noAnswer) F('warn', t('{n} calls were not answered within {s} s and were cancelled.', { n: r0(T.noAnswer), s: r0(test.maxRing) }));
      if (T.byeFail || T.byeTimeout) F('warn', t('{n} BYE requests failed or got no response; those calls may stay open on the server.', { n: r0((T.byeFail || 0) + (T.byeTimeout || 0)) }));
      if (T.rtpCalls) {
        if (T.rtpLossPct != null) F(T.rtpLossPct > 1 ? 'bad' : T.rtpLossPct > 0.1 ? 'warn' : 'ok', t('Media on {n} calls: {loss}% packet loss, jitter p95 {jit} ms.', { n: r0(T.rtpCalls), loss: pc(T.rtpLossPct), jit: r1(T.jitter && T.jitter.p95) })
          + (T.rtt && T.rtt.n ? ' ' + t('Echo round trip p95 {rtt} ms.', { rtt: r1(T.rtt.p95) }) : ''));
        if (T.noMedia) F('warn', t('{n} answered calls received no audio at all. Expected if the extension does not send media; otherwise check NAT, the firewall (RTP ports) or media relay capacity.', { n: r0(T.noMedia) }));
        else if (!T.rtpRx) F('warn', t('No RTP came back on any call. Use an echo or announcement extension to measure media.'));
      }
    }
    if (E) {
      if (!E.reached) F('bad', t('No call reached the vendor. Check that your PBX routes the destination prefix to the built-in vendor (trunk address, port, authentication).'));
      else {
        F(E.missing ? 'bad' : 'ok', E.missing
          ? t('{n} of {sent} calls ({pct}%) never reached the vendor: they were rejected or lost inside the PBX.', { n: r0(E.missing), sent: r0(E.sent), pct: pc(missPct) })
          : t('All {n} calls reached the vendor through the PBX.', { n: r0(E.sent) }));
        if (E.lat && E.lat.n) F('ok', t('PBX routing delay (client INVITE → vendor INVITE): p50 {p50} ms, p95 {p95} ms, p99 {p99} ms.', { p50: r1(E.lat.p50), p95: r1(E.lat.p95), p99: r1(E.lat.p99) }));
        if (out.e2eOnset) F('warn', t('PBX routing delay rose at {time}, at about {tps} {unit} (p95 {base} → {p95} ms): the PBX takes longer to send calls to the trunk.', { time: mmss(out.e2eOnset.t), tps: r0(out.e2eOnset.tps), unit: U, base: r1(out.e2eOnset.base), p95: r1(out.e2eOnset.p95) }));
        // Several trunks: who took the calls, failover and its cost
        const TR = E.trunks || [];
        if (TR.length > 1) {
          const acc = sum(TR.map(x => x.acc));
          F('ok', t('Calls taken by trunk: {list}.', { list: TR.map((x, i) => `${'ABCD'[i]} ${r0(acc ? x.acc / acc * 100 : 0)}% (${r0(x.acc)})`).join(', ') }));
          if (E.failover) F('warn', t('{n} calls ({pct}%) failed over: a trunk rejected them and the PBX sent them to another trunk. Failover added p50 {p50} ms, p95 {p95} ms before a trunk took the call.', {
            n: r0(E.failover), pct: pc(E.failover / E.reached * 100), p50: r1(E.foLat && E.foLat.p50), p95: r1(E.foLat && E.foLat.p95) })
            + (out.foOnset ? ' ' + t('Failover started at {time}, at about {tps} {unit}.', { time: mmss(out.foOnset.t), tps: r0(out.foOnset.tps), unit: U }) : ''));
          else if (sum(TR.map(x => x.rej))) F('warn', t('Trunks rejected calls but the PBX did not send any of them to another trunk: check the failover rule on the PBX.'));
          else F('ok', t('No trunk rejected a call, so no failover was needed.'));
        }
        if (E.allRejected) F('bad', t('{n} calls were rejected by every trunk they reached.', { n: r0(E.allRejected) }));
      }
      // Where did the failures happen: inside the PBX or after the call reached the trunk?
      const fails = (T.err || 0) - (T.noAnswer || 0);
      if (E.reached && fails > 0 && !E.missing) F('warn', t('Every call reached the vendor, so the {n} failures happened on the trunk side (vendor answers passed back by the PBX), not inside the PBX.', { n: r0(fails) }));
      else if (E.reached && fails > 0 && E.missing >= fails * 0.9) F('warn', t('The failed calls never reached the vendor: the PBX itself rejected or lost them.'));
      if (E.dup) F('bad', t('{n} calls were taken by the vendor more than once: the PBX sent the same call again after a trunk had already taken it.', { n: r0(E.dup) }));
      if (E.unmatched) F('warn', t('{n} calls arrived at the vendor with a number the test did not send. The PBX may rewrite the dialled number, or other traffic reaches the vendor.', { n: r0(E.unmatched) }));
    }
    if (T.throttled) F('warn', t('{n} × 503 Service Unavailable received (first at {time}).', { n: r0(T.throttled), time: mmss((ev.find(e => e.type === 'throttle') || {}).t || 0) }));
    if (T.timeouts) F('bad', t('{n} requests got no final response (timeout).', { n: r0(T.timeouts) }));
    if (T.retrans && sent) { const p = T.retrans / sent * 100; if (p > 1) F(p > 5 ? 'bad' : 'warn', t('{n} retransmissions ({pct}% of requests): the server or network answered late or dropped packets.', { n: r0(T.retrans), pct: r1(p) })); }
    const drops = ev.filter(e => e.type === 'session');
    if (drops.length) F('bad', t('{n} connection(s) were closed during the test (first at {time}).', { n: drops.length, time: mmss(drops[0].t) }));
    const errs = Object.entries(T.errs || {}).filter(([k]) => k !== 'TIMEOUT' && !/^503/.test(k));
    if (errs.length) F('bad', t('Failure responses: {list}.', { list: errs.sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} × ${r0(v)}`).join(', ') }));
    if (errs.some(([k]) => /^40[17]/.test(k))) F('warn', t('Authentication failed: check the username, password or password template.'));
    out.fmt = { r0, r1, mmss, pc };
    return out;
  }

  // Short summary for the archive list
  function summary(rep) {
    const a = analyze(rep), T = rep.totals || {};
    return {
      verdict: a.verdict, capacity: a.capacity ? Math.round(a.capacity.ok * 10) / 10 : null, unit: a.unit, scenario: a.scenario,
      onsetTps: a.onset ? Math.round(a.onset.tps * 10) / 10 : null, kneeTps: a.knee ? a.knee.target : null,
      p95: T.lat && T.lat.p95, sent: T.sent, err: T.err, asr: T.asr, e2eP95: T.e2e && T.e2e.lat ? T.e2e.lat.p95 : null,
      issues: a.findings.filter(f => f.level !== 'ok').length,
    };
  }

  return { analyze, summary };
});
