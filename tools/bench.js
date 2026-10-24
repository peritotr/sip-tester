// Benchmark: calls at a fixed rate against the built-in test UAS, each in its own process.
// Usage: node tools/bench.js [cps=1000] [seconds=30] [hold=10] [rtpCalls=0]
const { fork } = require('child_process');
const path = require('path');
const [cps = 1000, secs = 30, hold = 10, rtp = 0] = process.argv.slice(2).map(Number);

if (process.argv[2] === '--uas') {
  const { TestUas } = require('../uas');
  new TestUas({ port: 0 }).start().then(u => process.send({ port: u.port }));
  setInterval(() => {}, 1e6);
} else {
  const uas = fork(__filename, ['--uas']);
  uas.on('message', ({ port }) => {
    console.log(`${cps} CPS for ${secs} s, ${hold} s calls${rtp ? `, RTP on up to ${rtp} calls` : ''} → test UAS on udp/${port}`);
    const w = fork(path.join(__dirname, '..', 'load-worker.js'));
    w.on('message', m => {
      if (m.type === 'tick') { const r = m.row; process.stdout.write(`\r${String(r.t).padStart(4)} s  attempts ${r.sentTps.toFixed(0).padStart(5)}/s  answered ${r.okTps.toFixed(0).padStart(5)}/s  active ${String(r.inflight).padStart(6)}  PDD p95 ${(r.p95 || 0).toFixed(1).padStart(6)} ms  `); }
      if (m.type === 'phase' && m.phase === 'error') { console.error('\n' + m.text); w.kill(); uas.kill(); }
      if (m.type === 'done') {
        const T = m.totals;
        console.log(`\n\nattempts ${T.sent} · answered ${T.ok} · failed ${T.err} · retransmissions ${T.retrans} · peak active ${T.maxActive}`);
        console.log(`PDD ms  p50 ${T.lat.p50?.toFixed(2)}  p95 ${T.lat.p95?.toFixed(2)}  p99 ${T.lat.p99?.toFixed(2)}  max ${T.lat.max?.toFixed(2)}`);
        if (T.rtpCalls) console.log(`RTP: ${T.rtpCalls} calls, loss ${T.rtpLossPct?.toFixed(3)}%, jitter p95 ${T.jitter.p95?.toFixed(2)} ms`);
        w.kill(); uas.kill();
      }
    });
    w.send({ type: 'start', cfg: { host: '127.0.0.1', port }, test: { scenario: 'call', rate: cps, duration: secs, holdMin: hold, holdMax: hold, dst: '9XXXXXX', concurrent: 200000, rtp: !!rtp, rtpMax: rtp || 1, ramp: 0 } });
  });
}
