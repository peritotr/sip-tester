// Shared helpers: run the load engine as a child process (like the apps do) against the built-in test UAS.
const { fork } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');

// Runs one or more load tests in ONE worker process, sequentially; resolves with [{ done, phases, ticks, logs }]
function runLoads(cfg, tests, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = fork(path.join(root, 'load-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const results = []; let out;
    const timer = setTimeout(() => { p.kill(); reject(new Error('load test timed out')); }, timeoutMs);
    const next = () => {
      if (results.length === tests.length) { clearTimeout(timer); p.kill(); return resolve(results); }
      out = { phases: [], ticks: [], logs: [] }; results.push(out);
      p.send({ type: 'start', cfg, test: tests[results.length - 1] });
    };
    p.on('message', m => {
      if (m.type === 'phase') { out.phases.push(m); if (m.phase === 'error') next(); }
      else if (m.type === 'tick') out.ticks.push(m.row);
      else if (m.type === 'log') out.logs.push(m);
      else if (m.type === 'done') { out.done = m; setTimeout(next, 200); }
    });
    next();
  });
}
const runLoad = (cfg, test, timeoutMs) => runLoads(cfg, [test], timeoutMs).then(r => r[0]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { runLoad, runLoads, sleep, root };
