const test = require('node:test');
const assert = require('node:assert/strict');
const { extractStatusIntent, extractDecomIntent } = require('../src/decomIntent');

test('status with a server name or a Change number is a lookup', () => {
  const cases = [
    ['Status DECOM-TEST-24', 'DECOM-TEST-24'],
    ['status CHG0000068', 'CHG0000068'],
    ['Status of chg68', 'chg68'],
    ['status for web-01.corp.local', 'web-01.corp.local'],
    ['status: server-01', 'server-01'],
    ['Status – web-01', 'web-01'],
    ['decommission status SRV1', 'SRV1'],
    ['@novadesk-bot status SRV1', 'SRV1'],
    ['  STATUS   SRV1  ?', 'SRV1'],
  ];
  for (const [text, query] of cases) assert.deepEqual(extractStatusIntent(text), { query }, text);
});

test('ordinary sentences that contain the word status are left alone', () => {
  for (const text of ['what is the status of the decommission', 'status of the project', 'the status update for srv1 is bad',
    'status SRV1 please', 'any status on this?', 'Decommission SRV1', 'pre-decommission status', '', null, 42]) {
    assert.equal(extractStatusIntent(text), null, String(text));
  }
});

test('a bare status asks for help and is never a lookup', () => {
  for (const text of ['status', 'Status?', 'decommission status', '@novadesk-bot status']) {
    assert.deepEqual(extractStatusIntent(text), { help: true }, text);
  }
});

test('a status lookup is not also a decommission request', () => {
  for (const text of ['status SRV1', 'status CHG0000068']) assert.equal(extractDecomIntent(text), null, text);
  // "decommission status SRV1" used to read as a request for a host called "status"; "status" is now
  // on the not-a-host list, and decomFlow.handleDecomTrigger still checks for a status lookup first.
  assert.equal(extractDecomIntent('decommission status SRV1'), null);
  assert.deepEqual(extractStatusIntent('decommission status SRV1'), { query: 'SRV1' });
});
