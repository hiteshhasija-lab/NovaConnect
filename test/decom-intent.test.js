const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDecomIntent, mentionsDecommission } = require('../src/decomIntent');

test('only standalone Decommission starts a request', () => {
  for (const text of ['pre-decommission TESTVM01', 'Pre-Decommission WIN-TEST',
    'pre–decommission TESTVM01', 'pre‑decommission TESTVM01',
    'decommissioning TESTVM01', 'decommissioned TESTVM01',
    'undecommission TESTVM01', 'decommission-TESTVM01', 'Decommission',
    'pre_decommission TESTVM01']) {
    assert.equal(extractDecomIntent(text), null, text);
  }
});

test('explicit commands retain case, polite prefixes and hostname support', () => {
  for (const text of ['Decommission WIN-TEST', 'decommission WIN-TEST',
    'Please DECOMMISSION WIN-TEST', 'Can you decommission: WIN-TEST']) {
    assert.deepEqual(extractDecomIntent(text), { hostname: 'WIN-TEST' }, text);
  }
  assert.deepEqual(extractDecomIntent('Decommission esxi-01.lab'), { hostname: 'esxi-01.lab' });
});

test('ordinary sentences that use the word are not requests', () => {
  for (const text of ['the decommission today', 'decommission today', 'we should decommission webserver',
    'decommission status', 'decommission 10', 'decommission it', 'I will decommission them tomorrow',
    'decommission process is slow', 'decommission server', 'status of the decommission',
    'when is the decommission planned', "let's decommission webserver"]) {
    assert.equal(extractDecomIntent(text), null, text);
  }
});

test('requests inside a sentence still work when the name looks like a host', () => {
  const cases = [
    ['I think we should decommission web-01', 'web-01'],
    ['we should decommission db_prod_02, thanks', 'db_prod_02'],
    ['ok decommission VMHOST', 'VMHOST'],
    ['please decommission SRV01', 'SRV01'],
    ['decommission the server web-01', 'web-01'],
    ['decommission web-01.', 'web-01'],
    ['@novadesk-bot decommission web-01', 'web-01'],
    ['I need you to decommission VMHOST', 'VMHOST']
  ];
  for (const [text, hostname] of cases) assert.deepEqual(extractDecomIntent(text), { hostname }, text);
});

test('mentionsDecommission only fires on the standalone word', () => {
  assert.equal(mentionsDecommission('the decommission today'), true);
  assert.equal(mentionsDecommission('decommissioning is slow'), false);
  assert.equal(mentionsDecommission('pre-decommission X1'), false);
  assert.equal(mentionsDecommission(null), false);
});
