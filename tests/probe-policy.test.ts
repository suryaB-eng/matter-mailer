import test from 'node:test';
import assert from 'node:assert/strict';
import { coarseImapSince, probeMatch, probeSubject, validateProbeArgs } from '../src/probe-policy.js';

const recipient = 'explicit-test@example.net';
const nonce = '7d1382354c9ad32f217446ca1c3d8f60';
const start = new Date('2026-10-27T21:00:00Z');
const base = {
  from: [recipient], to: ['dedicated@gmail.com'], subject: `matter-mailer probe ${nonce}`,
  internalDate: new Date('2026-10-27T21:00:01Z'), size: 200, autoSubmitted: 'no',
  listId: false, returnPath: '<explicit-test@example.net>', replyTo: [],
};
test('probe requires explicit single separate mailbox and unpredictable nonce', () => {
  assert.equal(validateProbeArgs(recipient, nonce, 'dedicated@gmail.com').recipient, recipient);
  for (const invalid of ['', 'a@example.net,b@example.net', 'Name <a@example.net>', 'a@example.net\r\nBcc:b@example.net']) {
    assert.throws(() => validateProbeArgs(invalid, nonce, 'dedicated@gmail.com'));
  }
  assert.throws(() => validateProbeArgs('dedicated@gmail.com', nonce, 'dedicated@gmail.com'));
  assert.throws(() => validateProbeArgs(recipient, 'guessable', 'dedicated@gmail.com'));
  assert.equal(probeSubject(nonce), base.subject);
});
test('probe matches only exact nonce/from/destination and new server receipt time', () => {
  const matches = (change: Partial<typeof base>) => probeMatch({ ...base, ...change }, recipient, nonce, 'dedicated@gmail.com', start);
  assert.equal(matches({}), true);
  assert.equal(matches({ subject: 'Please fetch Key Documents M01234' }), false);
  assert.equal(matches({ subject: `Re: ${base.subject}` }), false);
  assert.equal(matches({ from: ['someone@example.net'] }), false);
  assert.equal(matches({ from: [recipient, 'someone@example.net'] }), false);
  assert.equal(matches({ to: ['other@gmail.com'] }), false);
  assert.equal(matches({ internalDate: new Date(start.getTime() - 1) }), false);
  assert.equal(matches({ size: 1_000_001 }), false);
  assert.equal(matches({ autoSubmitted: 'auto-replied' }), false);
  assert.equal(matches({ listId: true }), false);
  assert.equal(matches({ returnPath: '<>' }), false);
  assert.equal(matches({ replyTo: ['different@example.net'] }), false);
});
test('coarse IMAP SINCE is the previous UTC date so Gmail local-date skew still finds the message', () => {
  assert.equal(coarseImapSince(new Date('2026-10-28T02:05:20.538Z')).toISOString(), '2026-10-27T00:00:00.000Z');
  assert.equal(coarseImapSince(new Date('2026-10-28T00:00:00.000Z')).toISOString(), '2026-10-27T00:00:00.000Z');
  assert.equal(coarseImapSince(new Date('2026-11-01T00:30:00.000Z')).toISOString(), '2026-10-31T00:00:00.000Z');
});
