// Archive of load test reports (shared by the web server and the desktop app).
// Each report is <dir>/<id>.json; <dir>/index.json keeps short summaries for the list.
const fs = require('fs');
const path = require('path');
const { summary } = require('./ui/analysis.js');

class ReportStore {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  _idx() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')); } catch { return this._rebuild(); } }
  _writeIdx(list) { fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(list)); }
  _rebuild() {
    const list = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!/^\d{8}-\d{6}-[a-z0-9]+\.json$/.test(f)) continue;
      try { list.push(this._entry(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')))); } catch {}
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    this._writeIdx(list); return list;
  }
  _entry(rep) {
    let s = {}; try { s = summary(rep); } catch {}
    return { id: rep.id, name: rep.name || '', createdAt: rep.createdAt, host: rep.cfg && rep.cfg.host, target: rep.test && (rep.test.rate || rep.test.tps),
      mode: rep.test && rep.test.steps ? 'step' : 'constant', secs: rep.totals && rep.totals.secs, ...s };
  }
  save(rep) {
    const d = new Date(rep.createdAt || Date.now());
    const p = n => String(n).padStart(2, '0');
    rep.id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
    fs.writeFileSync(path.join(this.dir, rep.id + '.json'), JSON.stringify(rep));
    const list = this._idx().filter(e => e.id !== rep.id);
    const entry = this._entry(rep); list.unshift(entry); this._writeIdx(list);
    return entry;
  }
  list() { return this._idx(); }
  get(id) {
    if (!/^[\w-]+$/.test(String(id))) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, id + '.json'), 'utf8')); } catch { return null; }
  }
  remove(id) {
    if (!/^[\w-]+$/.test(String(id))) return false;
    try { fs.unlinkSync(path.join(this.dir, id + '.json')); } catch {}
    this._writeIdx(this._idx().filter(e => e.id !== id)); return true;
  }
  rename(id, name) {
    const rep = this.get(id); if (!rep) return false;
    rep.name = String(name || '').slice(0, 120);
    fs.writeFileSync(path.join(this.dir, id + '.json'), JSON.stringify(rep));
    this._writeIdx(this._idx().map(e => e.id === id ? { ...e, name: rep.name } : e)); return true;
  }
}

// Vendor settings without passwords, with the ports the trunks actually got (port 0 = picked by the OS)
function vendorPublic(opts, ports) {
  if (!opts) return null;
  const o = { ...opts, password: undefined };
  if (ports && ports.length) o.port = ports[0];
  if (Array.isArray(o.trunks)) o.trunks = o.trunks.map((t, i) => ({ ...t, password: undefined, port: ports && ports[i] != null ? ports[i] : t.port }));
  return o;
}

// Combines the engine's 'done' output and the start request into one report
function assembleReport({ done, req, series, vendor, app }) {
  const cfg = req && req.cfg || {};
  return {
    version: 1, app: app || 'sip-tester',
    name: (req && req.test && req.test.name) || '',
    createdAt: done.endedAt || Date.now(), startedAt: done.startedAt, endedAt: done.endedAt,
    cfg: { host: cfg.host, port: cfg.port, transport: cfg.transport || 'udp', domain: cfg.domain, user: cfg.user },
    test: { ...done.test, passTpl: done.test && done.test.passTpl ? '•••' : '' }, // never store passwords
    totals: done.totals,
    series: series && series.length ? series : done.series,
    events: done.events || [],
    vendor: vendor ? { opts: vendorPublic(vendor) } : null,
  };
}

module.exports = { ReportStore, assembleReport, vendorPublic };
