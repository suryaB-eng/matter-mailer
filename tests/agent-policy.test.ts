import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { interpretMessage, type ModelFn } from '../src/interpret.js';
import { archiveFilename, classifyHeader, fitReply, renderMime, replySubject, withinMimeLimit, type HeaderView } from '../src/mail.js';
import { OVERLAP_NOTE } from '../src/matter.js';
import { renderClarify, renderFetch, renderInterrupted, renderSystem, REQUEST_EXAMPLE } from '../src/reply.js';
import { classifyRestart, openLedger, type NewMessage } from '../src/state.js';
import type { FetchReport } from '../src/fetch.js';

const agent = 'agent@gmail.com';
const person = 'person@example.com';
const fetchBody = 'Please send the key documents for M01234.';
const fetchModel = {
  action: 'fetch', matter: 'M01234', category: 'Key Documents',
  matterQuote: 'M01234', categoryQuote: 'key documents', reason: '',
};

function modelReturning(value: unknown): ModelFn {
  return async () => typeof value === 'string' ? value : JSON.stringify(value);
}

function header(change: Partial<HeaderView> = {}): HeaderView {
  return {
    subject: 'Key documents for M01234', from: [person], replyTo: [], size: 200,
    autoSubmitted: 'no', listId: false, returnPath: `<${person}>`, ...change,
  };
}

function sample(gmailId: string, state: NewMessage['state'] = 'processing'): NewMessage {
  return {
    gmailId, receivedAt: '2026-10-28T02:10:00.000Z', recipient: person,
    messageId: '<m@example.com>', referencesHeader: '<m@example.com>',
    subject: 'Key documents for M01234', state, outcome: null, error: null,
  };
}

function report(outcome: FetchReport['outcome']): FetchReport {
  const success = outcome === 'success';
  return {
    outcome, matter: 'M01234', category: 'Key Documents', url: 'https://uarb.novascotia.ca/fmi/webd/UARB15',
    observedAt: '2026-10-28T02:55:01.148Z', metadata: [{ label: 'Matter No', value: 'M01234', view: 'detail' }],
    counts: { Exhibits: 0, 'Key Documents': success ? 1 : 0, 'Other Documents': 1, Transcripts: null, Recordings: 0 },
    overlap: OVERLAP_NOTE, foundCount: success ? 1 : 0, selectionComplete: true,
    selectedRecords: success ? [{ recordId: '00880', order: 1 }] : [],
    files: success ? [{ recordId: '00880', archiveName: 'a.pdf', path: '/data/jobs/job/files/a.pdf', bytes: 10, sha256: 'abc' }] : [],
    omissions: [], zipPath: success ? '/data/jobs/job/a.zip' : null, zipBytes: success ? 20 : null, zipSha256: success ? 'def' : null,
    jobDir: '/data/jobs/job', mailSent: false,
  };
}

test('valid paraphrase, leading zeros, negation, and missing or conflicting fields', async () => {
  const paraphrase = await interpretMessage('documents', 'Could you grab the key docs for M01234 please', modelReturning({ ...fetchModel, categoryQuote: 'key docs' }));
  assert.deepEqual(paraphrase, { kind: 'fetch', matter: 'M01234', category: 'Key Documents' });

  let calls = 0;
  const short = await interpretMessage('files', 'Please send the key documents for M1234.', async () => { calls += 1; return '{}'; });
  assert.equal(calls, 0);
  assert.deepEqual(short, { kind: 'clarify', reason: 'missing-matter' });
  const padded = await interpretMessage('files', fetchBody, modelReturning({ ...fetchModel, matter: 'M12340' }));
  assert.deepEqual(padded, { kind: 'systemError', reason: 'ungrounded' });

  const negated = 'I do not want the exhibits. Please send the key documents for M01234.';
  const wrong = await interpretMessage('request', negated, modelReturning({ ...fetchModel, category: 'Exhibits', categoryQuote: 'exhibits' }));
  assert.deepEqual(wrong, { kind: 'systemError', reason: 'ungrounded' });
  const right = await interpretMessage('request', negated, modelReturning(fetchModel));
  assert.deepEqual(right, { kind: 'fetch', matter: 'M01234', category: 'Key Documents' });

  assert.deepEqual(await interpretMessage('request', 'Please send the key documents.', modelReturning(fetchModel)), { kind: 'clarify', reason: 'missing-matter' });
  assert.deepEqual(await interpretMessage('request', 'Please send the key documents for M01234 and M12205.', modelReturning(fetchModel)), { kind: 'clarify', reason: 'conflict-matter' });
  assert.deepEqual(await interpretMessage('request', 'Please send the key documents and the exhibits for M01234.', modelReturning(fetchModel)), { kind: 'clarify', reason: 'conflict-category' });
});

test('unsupported category, quoted history, thanks-only, malformed output, and quota', async () => {
  const unsupported = await interpretMessage('request', 'Please send the invoices for M01234.', modelReturning({
    action: 'clarify', matter: 'M01234', category: '', matterQuote: 'M01234', categoryQuote: '', reason: 'That category is not supported.',
  }));
  assert.equal(unsupported.kind, 'clarify');

  let quotedCalls = 0;
  const quoted = await interpretMessage('note', 'See below.\nOn Tue, Oct 27, 2026, Alex wrote:\n> Please send the key documents for M01234.', async () => { quotedCalls += 1; return '{}'; });
  assert.equal(quotedCalls, 0);
  assert.deepEqual(quoted, { kind: 'clarify', reason: 'quoted-only' });

  let thanksCalls = 0;
  const thanks = await interpretMessage('Re: Key documents for M01234', 'Thanks!', async () => { thanksCalls += 1; return '{}'; });
  assert.equal(thanksCalls, 0);
  assert.deepEqual(thanks, { kind: 'ignore', reason: 'thanks' });

  let malformedCalls = 0;
  const malformed = await interpretMessage('request', fetchBody, async () => { malformedCalls += 1; return 'not json'; });
  assert.equal(malformedCalls, 1);
  assert.deepEqual(malformed, { kind: 'systemError', reason: 'malformed' });

  let quotaCalls = 0;
  const quota = await interpretMessage('request', fetchBody, async () => { quotaCalls += 1; throw Object.assign(new Error('quota'), { status: 429 }); });
  assert.equal(quotaCalls, 2);
  assert.deepEqual(quota, { kind: 'systemError', reason: 'quota' });

  let retryCalls = 0;
  const recovered = await interpretMessage('request', fetchBody, async () => {
    retryCalls += 1;
    if (retryCalls === 1) throw Object.assign(new Error('unavailable'), { status: 503 });
    return JSON.stringify(fetchModel);
  });
  assert.equal(retryCalls, 2);
  assert.deepEqual(recovered, { kind: 'fetch', matter: 'M01234', category: 'Key Documents' });
});

test('one gmail id is never a second job, including after a read-flag change, and a new id is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'matter-mailer-ledger-'));
  const ledger = openLedger(dir);
  try {
    const id = '1880258482139267733';
    assert.equal(ledger.claim(sample(id)), 'claimed');
    assert.equal(ledger.claim({ ...sample(id), subject: 'seen flag changed' }), 'duplicate');
    assert.equal(ledger.get(id)?.gmailId, id);
    assert.equal(ledger.get(id)?.subject, 'Key documents for M01234');
    assert.equal(ledger.claim(sample('1880258482139267734')), 'claimed');
    assert.equal(ledger.inspect().length, 2);
  } finally { ledger.close(); }
});

test('interrupted SMTP becomes review and is never selected for another send', () => {
  const dir = mkdtempSync(join(tmpdir(), 'matter-mailer-ledger-'));
  const ledger = openLedger(dir);
  try {
    assert.equal(ledger.claim(sample('1')), 'claimed');
    ledger.beginSend('1');
    assert.equal(ledger.claim(sample('2')), 'claimed');
    assert.deepEqual(classifyRestart(ledger).map(row => row.gmailId), ['2']);
    assert.equal(ledger.get('1')?.state, 'review');
    assert.match(ledger.get('1')?.error ?? '', /check Sent/);
    assert.throws(() => ledger.beginSend('1'));
    ledger.beginSend('2');
    ledger.finishSend('2', 'review', 'interrupted', 'smtp_unknown', null);
    assert.deepEqual(classifyRestart(ledger), []);
    assert.equal(ledger.get('2')?.state, 'review');
  } finally { ledger.close(); }
});

test('routing uses one reply-to or from and never a second address', () => {
  assert.deepEqual(classifyHeader(header({ replyTo: ['a@example.com', 'b@example.com'] }), agent), { kind: 'hold', reason: 'ambiguous' });
  assert.deepEqual(classifyHeader(header({ from: ['a@example.com', 'b@example.com'] }), agent), { kind: 'hold', reason: 'ambiguous' });
  assert.equal(classifyHeader(header({ from: [agent] }), agent).kind, 'ignore');
  assert.equal(classifyHeader(header({ autoSubmitted: 'auto-replied' }), agent).kind, 'ignore');
  assert.equal(classifyHeader(header({ listId: true }), agent).kind, 'ignore');
  assert.equal(classifyHeader(header({ returnPath: '<>' }), agent).kind, 'ignore');
  assert.equal(classifyHeader(header({ subject: 'matter-mailer probe 7c94b76cfec96da7ab81304bec877c4f' }), agent).kind, 'ignore');
  assert.deepEqual(classifyHeader(header({ from: ['other@example.com'], replyTo: [person] }), agent), { kind: 'read', recipient: person });
  assert.deepEqual(classifyHeader(header({ size: 1_000_001 }), agent), { kind: 'oversized', recipient: person });
  assert.equal(replySubject('Key documents for M01234'), 'Re: Key documents for M01234');
  assert.equal(replySubject('Re: Key documents for M01234'), 'Re: Key documents for M01234');
  assert.equal(archiveFilename('M01234', 'Key Documents'), 'M01234-key-documents.zip');
});

test('replies state counts, overlap, and no empty archive', async () => {
  const empty = renderFetch(report('empty'));
  assert.equal(empty.attachZip, false);
  assert.match(empty.text, /Transcripts: unknown/);
  assert.match(empty.text, new RegExp(OVERLAP_NOTE.replace(/[.]/g, '\\.')));
  assert.match(empty.text, /No archive is attached/);
  const success = renderFetch(report('success'));
  assert.equal(success.attachZip, true);
  assert.match(success.text, /Exhibits: 0/);
  assert.match(success.text, /Attached 1 source record and 1 file/);
  assert.match(renderClarify('conflict-matter'), new RegExp(REQUEST_EXAMPLE));
  assert.match(renderSystem('quota'), /temporarily unavailable/);
  assert.match(renderInterrupted(), /was not retried/);
  assert.match(renderInterrupted(), /No archive is attached/);

  const mail = {
    recipient: person, subject: 'Re: Key documents for M01234', text: 'Counted reply.',
    messageId: '<abc@example.com>', references: '<abc@example.com>', attachment: null,
  };
  const mime = await renderMime(agent, mail);
  assert.match(mime.toString('utf8'), /Auto-Submitted:\s*auto-replied/i);
  assert.match(mime.toString('utf8'), /In-Reply-To:\s*<abc@example.com>/i);
  assert.equal(withinMimeLimit(mime.length, null), true);
  assert.equal(withinMimeLimit(30_000_001, null), false);
  assert.equal(withinMimeLimit(5_000, 4_000), false);
  const fitted = await fitReply(agent, mail, null);
  assert.equal(fitted.blocked, false);
  assert.equal(fitted.droppedZip, false);
});
