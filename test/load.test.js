// Load engine end to end, in its own process, against the built-in test UAS
const test = require('node:test');
const assert = require('node:assert');
const { runLoad, runLoads } = require('./helpers');
const { TestUas } = require('../uas');
const { analyze, summary } = require('../ui/analysis');
const { parseUsers } = require('../load-engine');

test('account lists', () => {
  assert.deepEqual(parseUsers('1000-1002, alice;0099-0100'), ['1000', '1001', '1002', 'alice', '0099', '0100']);
});

test('calls: constant rate, auth, RTP, everything answered and completed', async () => {
  const uas = await new TestUas({ port: 0, auth: { realm: 'r', passwordIsUser: true }, authInvite: true, ringMs: 10, answerMs: 20 }).start();
  try {
    const r = await runLoad({ host: '127.0.0.1', port: uas.port }, { scenario: 'call', rate: 40, duration: 4, holdMin: 0.5, holdMax: 1, dst: '9XXXXXX', users: '1000-1019', passTpl: '{user}', rtp: true, rtpMax: 30, concurrent: 500, ramp: 0 });
    const T = r.done.totals;
    assert.ok(T.sent >= 150 && T.sent <= 165, `sent ${T.sent}`);
    assert.equal(T.ok, T.sent); assert.equal(T.err, 0); assert.equal(T.completed, T.sent); assert.equal(T.asr, 100);
    assert.equal(T.challenges, T.sent, 'every INVITE was challenged once');
    assert.ok(T.rtpCalls > 50 && T.rtpRx > 1000, `rtp ${T.rtpCalls} calls, ${T.rtpRx} packets`);
    assert.ok(T.rtpLossPct < 1);
    assert.ok(T.lat.p50 >= 8, 'PDD includes the ring delay');
    const a = analyze({ test: r.done.test, totals: T, series: r.done.series, events: r.done.events });
    assert.equal(a.saturation, null);
    assert.ok(a.findings.some(f => /ASR 100/.test(f.text)));
  } finally { uas.stop(); }
});

test('503 overload is counted, backs off, and the analysis names it', async () => {
  const uas = await new TestUas({ port: 0, maxCps: 20 }).start();
  try {
    const r = await runLoad({ host: '127.0.0.1', port: uas.port }, { scenario: 'call', rate: 50, duration: 6, holdMin: 0.2, holdMax: 0.2, dst: '1', concurrent: 1000, criteria: { asrMin: 99 } });
    const T = r.done.totals;
    assert.ok(T.throttled > 30, `503s ${T.throttled}`);
    assert.ok(T.sent < 300, 'rate backed off below the 50 CPS target');
    const a = analyze({ test: r.done.test, totals: T, series: r.done.series, events: r.done.events });
    assert.equal(a.saturation && a.saturation.cause, 'throttle');
    assert.equal(a.verdict, 'fail');
  } finally { uas.stop(); }
});

test('step test finds the knee of a capacity-limited server; second run in the same worker counts from zero', async () => {
  const uas = await new TestUas({ port: 0, capacity: 60 }).start();
  try {
    const cfg = { host: '127.0.0.1', port: uas.port };
    const [r1, r2] = await runLoads(cfg, [
      { scenario: 'register', rate: 100, steps: { start: 20, inc: 20, dur: 5 }, users: '3000-4999', expires: 60, concurrent: 2000 },
      { scenario: 'options', rate: 10, duration: 3, concurrent: 100 },
    ], 120000);
    const a = analyze({ test: r1.done.test, totals: r1.done.totals, series: r1.done.series, events: r1.done.events });
    assert.ok(a.knee, 'knee found');
    assert.ok(a.knee.target >= 60 && a.knee.target <= 80, `knee at ${a.knee.target}`);
    assert.ok(a.lastGood && a.lastGood.target >= 40 && a.lastGood.target <= 60, `last good ${a.lastGood && a.lastGood.target}`);
    const T2 = r2.done.totals;
    assert.ok(T2.sent >= 28 && T2.sent <= 32, `second run sent ${T2.sent}`);
    assert.equal(T2.ok, T2.sent);
    assert.ok(summary({ test: r2.done.test, totals: T2, series: r2.done.series }).capacity > 0);
  } finally { uas.stop(); }
});

test('registration storm with per-account passwords', async () => {
  const uas = await new TestUas({ port: 0, auth: { realm: 'r', passwordIsUser: true } }).start();
  try {
    const r = await runLoad({ host: '127.0.0.1', port: uas.port }, { scenario: 'register', rate: 100, duration: 3, users: '2000-2199', passTpl: '{user}', expires: 60, concurrent: 200 });
    const T = r.done.totals;
    assert.ok(T.sent >= 280, `sent ${T.sent}`); assert.equal(T.err, 0); assert.equal(T.ok, T.sent); assert.equal(T.challenges, T.sent);
    const bad = await runLoad({ host: '127.0.0.1', port: uas.port }, { scenario: 'register', rate: 20, duration: 1, users: '2000-2009', passTpl: 'wrong', expires: 60 });
    assert.equal(bad.done.totals.ok, 0);
    assert.ok(bad.done.totals.errs['401 Unauthorized'] > 0);
    const a = analyze({ test: bad.done.test, totals: bad.done.totals, series: bad.done.series, events: bad.done.events });
    assert.ok(a.findings.some(f => /Authentication failed/.test(f.text)));
  } finally { uas.stop(); }
});

test('unreachable host reports an error phase', async () => {
  const r = await runLoad({ host: 'no-such-host.invalid', port: 5060 }, { scenario: 'options', rate: 1, duration: 1 });
  assert.equal(r.phases.at(-1).phase, 'error');
  assert.match(r.phases.at(-1).text, /resolve/);
});
