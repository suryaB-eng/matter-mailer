import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMatterIdentity, parseRequest } from '../src/matter.js';

test('matter identity keeps leading zeros and rejects a different or short matter', () => {
  assert.deepEqual(parseRequest('m01234', 'key documents'), { matter: 'M01234', category: 'Key Documents' });
  assert.equal(parseRequest('M00100', 'recording').matter, 'M00100');
  assert.throws(() => parseRequest('M1234', 'Key Documents'), /five digits/);
  assert.throws(() => parseRequest('M012340', 'Key Documents'), /five digits/);
  assert.throws(() => parseRequest('M01234', 'Pleadings'), /Category/);
  assert.throws(() => assertMatterIdentity('M01234', 'M12205'), /mismatch/);
  assert.doesNotThrow(() => assertMatterIdentity('M01234', 'M01234'));
});
