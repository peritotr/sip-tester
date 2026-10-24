// SIP message handling, digest auth and the UAC call flow against the test UAS
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { parse, hdr, hdrAll, param, uriOf, Framer, parseChallenge, digest, parseSdp, SipUA, Call, register } = require('../sip-core');
const { RtpPool } = require('../rtp');
const { TestUas } = require('../uas');

test('parses requests with compact headers, folded lines and lists', () => {
  const m = parse('INVITE sip:100@x SIP/2.0\r\nv: SIP/2.0/UDP 1.2.3.4:5060;branch=z9hG4bKabc;rport\r\nf: "A, B" <sip:a@x>;tag=1\r\nTo: <sip:100@x>\r\ni: abc@h\r\nCSeq: 2 INVITE\r\n' +
    'Record-Route: <sip:p1;lr>, <sip:p2;lr>\r\nSubject: one\r\n two\r\nl: 4\r\n\r\nabcd');
  assert.equal(m.method, 'INVITE'); assert.equal(m.callId, 'abc@h'); assert.equal(m.cseq, 2); assert.equal(m.cseqMethod, 'INVITE');
  assert.equal(param(hdr(m, 'via'), 'branch'), 'z9hG4bKabc');
  assert.equal(param(hdr(m, 'from'), 'tag'), '1');
  assert.deepEqual(hdrAll(m, 'record-route'), ['<sip:p1;lr>', '<sip:p2;lr>']);
  assert.equal(hdr(m, 'subject'), 'one two'); assert.equal(m.body, 'abcd');
  assert.equal(uriOf('"x" <sip:a@b;transport=tcp>;tag=9'), 'sip:a@b;transport=tcp');
});

test('responses and garbage', () => {
  const r = parse('SIP/2.0 486 Busy Here\r\nCSeq: 1 INVITE\r\n\r\n');
  assert.equal(r.isReq, false); assert.equal(r.status, 486); assert.equal(r.reason, 'Busy Here');
  assert.equal(parse('hello world'), null);
});

test('TCP framing splits on Content-Length and keeps partial messages', () => {
  const f = new Framer();
  const a = f.push(Buffer.from('\r\nOPTIONS sip:x SIP/2.0\r\nContent-Length: 2\r\n\r\nhiSIP/2.0 200 OK\r\nl: 0\r\n\r\nSIP/2.0 1'));
  assert.equal(a.length, 2); assert.ok(a[0].endsWith('hi'));
  const b = f.push(Buffer.from('80 Ringing\r\nContent-Length: 0\r\n\r\n'));
  assert.equal(b.length, 1); assert.ok(b[0].startsWith('SIP/2.0 180'));
});

test('digest response matches RFC 2617 when qop is absent; qop=auth adds nc/cnonce', () => {
  const ch = parseChallenge('Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  const s = digest(ch, { user: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html' });
  const H = x => crypto.createHash('md5').update(x).digest('hex');
  const exp = H(`${H('Mufasa:testrealm@host.com:Circle Of Life')}:dcd98b7102dd2f0e8b11d0f600bfb0c093:${H('GET:/dir/index.html')}`);
  assert.match(s, new RegExp(`response="${exp}"`));
  const q = parseChallenge('Digest realm="r", nonce="n", qop="auth,auth-int", algorithm=MD5');
  assert.equal(q.qop, 'auth');
  assert.match(digest(q, { user: 'u', password: 'p', method: 'REGISTER', uri: 'sip:x' }), /qop=auth, nc=00000001, cnonce="[0-9a-f]+"/);
  assert.match(digest(q, { user: 'u', password: 'p', method: 'REGISTER', uri: 'sip:x' }), /nc=00000002/);
});

test('SDP answer', () => {
  const s = parseSdp('v=0\r\nc=IN IP4 10.0.0.1\r\nm=audio 12000 RTP/AVP 8 101\r\nc=IN IP4 10.0.0.2\r\n');
  assert.deepEqual([s.ip, s.port, s.pt], ['10.0.0.2', 12000, 8]);
});

for (const tcp of [false, true]) {
  test(`${tcp ? 'TCP' : 'UDP'}: REGISTER with challenge, call with auth, RTP echo, BYE`, async () => {
    const uas = await new TestUas({ port: 0, tcp, auth: { realm: 't', password: 'secret' }, authInvite: true, ringMs: 20, answerMs: 40 }).start();
    const ua = await new SipUA({ host: '127.0.0.1', port: uas.port, transport: tcp ? 'tcp' : 'udp' }).open();
    const calls = new Map(); ua.handler = m => { const c = calls.get(m.callId); if (c) { c.onRequest(m); return true; } };
    try {
      const reg = await new Promise(r => register(ua, { user: '1000', password: 'secret', expires: 60 }, (res, info) => r({ res, info })));
      assert.equal(reg.res.status, 200); assert.equal(reg.info.challenges, 1);
      const bad = await new Promise(r => register(ua, { user: '1000', password: 'nope', expires: 60 }, res => r(res)));
      assert.equal(bad.status, 401);
      const pool = new RtpPool(); const rtp = await pool.session('PCMU'); const tick = setInterval(() => pool.tick(), 10);
      const c = await new Promise(resolve => {
        const call = new Call({ ua, dst: '200', user: '1000', password: 'secret', sdp: { port: rtp.port, codec: 'PCMU' } }, {
          onAnswer: k => { rtp.start(k.remoteSdp.ip, k.remoteSdp.port, k.remoteSdp.pt); setTimeout(() => k.hangup(), 600); },
          onEnd: (k, why) => resolve({ k, why }),
        });
        calls.set(call.callId, call); call.start();
      });
      clearInterval(tick);
      assert.equal(c.why, 'bye'); assert.equal(c.k.byeStatus, 200); assert.equal(c.k.challenges, 1);
      assert.ok(c.k.t18x - c.k.t0 >= 15, 'PDD reflects the 180 delay');
      const s = rtp.summary();
      assert.ok(s.tx >= 20 && s.rx >= s.tx - 3, `RTP echoed (${s.tx}/${s.rx})`); assert.equal(s.lost, 0); assert.ok(s.rtt != null);
      pool.close();
    } finally { ua.close(); uas.stop(); }
  });
}

test('CANCEL after the ring limit, timeout and retransmissions with no server', async () => {
  const uas = await new TestUas({ port: 0, ringMs: 10, answerMs: 5000 }).start();
  const ua = await new SipUA({ host: '127.0.0.1', port: uas.port }).open();
  const why = await new Promise(r => { const c = new Call({ ua, dst: '1', maxRing: 300 }, { onFail: (k, s, re, w) => r({ s, w }) }); c.start(); });
  assert.deepEqual(why, { s: 487, w: 'noanswer' });
  assert.equal(uas.stats.cancels, 1);
  ua.close(); uas.stop();
  const ua2 = await new SipUA({ host: '127.0.0.1', port: 9, timeout: 1600 }).open();
  const end = await new Promise(r => { const c = new Call({ ua: ua2, dst: '1' }, { onEnd: (k, w) => r(w) }); c.start(); });
  assert.equal(end, 'timeout'); assert.equal(ua2.retrans, 2); // retransmitted at 500 ms and 1500 ms
  ua2.close();
});

test('server-side BYE ends the call as remoteBye', async () => {
  const uas = await new TestUas({ port: 0, hangupAfterMs: 200 }).start();
  const ua = await new SipUA({ host: '127.0.0.1', port: uas.port }).open();
  const calls = new Map(); ua.handler = m => { const c = calls.get(m.callId); if (c) { c.onRequest(m); return true; } };
  const why = await new Promise(r => { const c = new Call({ ua, dst: '1' }, { onEnd: (k, w) => r(w) }); calls.set(c.callId, c); c.start(); });
  assert.equal(why, 'remoteBye');
  ua.close(); uas.stop();
});
