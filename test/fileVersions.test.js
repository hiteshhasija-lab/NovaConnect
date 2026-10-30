const test = require('node:test');
const assert = require('node:assert/strict');
const { canChange, parseComment, fromUpload, fromVersion } = require('../src/fileVersions');

test('only whoever shared the file, or an admin, may change its versions', () => {
  const att = { uploaded_by: 7 };
  assert.equal(canChange(att, { id: 7, role: 'member' }), true);
  assert.equal(canChange(att, { id: '7', role: 'member' }), true);
  assert.equal(canChange(att, { id: 8, role: 'member' }), false);
  assert.equal(canChange(att, { id: 8, role: 'admin' }), true);
  assert.equal(canChange(att, null), false);
});

test('a version note is optional and short', () => {
  assert.equal(parseComment('  Updated   numbers ').value, 'Updated numbers');
  assert.equal(parseComment('').value, null);
  assert.equal(parseComment(undefined).value, null);
  assert.match(parseComment('x'.repeat(201)).error, /200/);
});

test('an upload or a kept version becomes the file columns of the current version', () => {
  const up = fromUpload({ originalname: 'plan.pdf', mimetype: 'application/pdf', size: 10 }, { stored: { key: 'k1', driver: 'local' }, t: { thumb_state: 'none' } });
  assert.deepEqual(up, { filename: 'k1', storage_key: 'k1', storage_driver: 'local', original_name: 'plan.pdf', mime_type: 'application/pdf', size: 10, thumb_state: 'none' });
  const back = fromVersion({ filename: 'k0', storage_key: 'k0', storage_driver: 's3', original_name: 'old.pdf', mime_type: 'application/pdf', size: 9, thumb_key: null, thumb_driver: null, thumb_mime: null, image_width: null, image_height: null, thumb_state: 'none', comment: 'x', version_no: 1 });
  assert.equal(back.storage_key, 'k0');
  assert.equal(back.storage_driver, 's3');
  assert.ok(!('comment' in back) && !('version_no' in back));
});
