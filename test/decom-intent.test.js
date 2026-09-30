const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDecomIntent } = require('../src/decomIntent');

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
