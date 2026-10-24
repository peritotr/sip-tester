const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
test('every UI string has a Turkish translation', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'i18n-keys.js')]).toString();
  assert.match(out, / 0 missing in TR/);
});
