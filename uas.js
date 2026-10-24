// Stand-alone test SIP server: the built-in vendor without the UI. Answers calls, echoes RTP, accepts any registration.
// Used by the test suite and the benchmark (as TestUas), and by `npm run uas` for trying the tool without a PBX.
//   node uas.js [port=5070] [maxCps=0]      (UAS_PASSWORD=… to require digest auth)
const { MockVendor } = require('./mock-vendor');

class TestUas extends MockVendor {}

module.exports = { TestUas };

if (require.main === module) {
  const port = Number(process.argv[2]) || 5070;
  const v = new TestUas({ port, host: '0.0.0.0', maxCps: Number(process.argv[3]) || 0, password: process.env.UAS_PASSWORD || '', authInvite: !!process.env.UAS_PASSWORD });
  v.start().then(() => console.log(`Test SIP server listening on udp+tcp/${v.port}`), e => { console.error(e.message); process.exit(1); });
}
