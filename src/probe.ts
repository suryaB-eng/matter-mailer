import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { simpleParser, type AddressObject } from 'mailparser';
import type { Config } from './config.js';
import { imap, smtp } from './connections.js';
import { coarseImapSince, probeMatch, probeSubject, validateProbeArgs } from './probe-policy.js';

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap(v => v.value.map(a => a.address ?? ''));
}
export async function probeZip(nonce: string): Promise<Buffer> {
  const content = Buffer.from(`matter-mailer connectivity probe\nNonce: ${nonce}\nThis generated ZIP contains no matter documents.\n`);
  const output = new PassThrough();
  const parts: Buffer[] = [];
  output.on('data', (chunk: Buffer) => parts.push(chunk));
  const done = new Promise<void>((resolve, reject) => { output.on('end', resolve); output.on('error', reject); });
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', e => output.destroy(e));
  archive.pipe(output);
  archive.append(content, { name: 'probe.txt' });
  await archive.finalize(); await done;
  const zip = Buffer.concat(parts);
  if (zip.length > 10_000) throw new Error('Probe ZIP too large');
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true, validateEntrySizes: true }, (err, reader) => {
      if (err || !reader) return reject(err ?? new Error());
      let entries = 0;
      reader.on('error', reject);
      reader.on('entry', entry => {
        if (++entries !== 1 || entry.fileName !== 'probe.txt' || entry.uncompressedSize !== content.length) { reader.close(); return reject(new Error('Invalid probe ZIP')); }
        reader.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error ?? new Error());
          const chunks: Buffer[] = [];
          stream.on('error', reject); stream.on('data', (b: Buffer) => chunks.push(b));
          stream.on('end', () => { if (!Buffer.concat(chunks).equals(content)) reject(new Error('ZIP readback mismatch')); else reader.readEntry(); });
        });
      });
      reader.on('end', () => entries === 1 ? resolve() : reject(new Error('Empty probe ZIP')));
      reader.readEntry();
    });
  });
  return zip;
}
export async function probe(c: Config, recipientArg: string, nonce: string) {
  const { recipient } = validateProbeArgs(recipientArg, nonce, c.GMAIL_ADDRESS);
  const started = new Date();
  // Use activation time, not process start, so a restarted listener can still see the user-initiated probe.
  const since = new Date(c.MAIL_START_AT);
  const subject = probeSubject(nonce);
  const evidenceDir = join(c.DATA_DIR, 'evidence');
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const path = join(evidenceDir, `probe-${createHash('sha256').update(nonce).digest('hex')}.json`);
  const evidence = { startedAt: started.toISOString(), host: hostname(), recipient, subject, state: 'waiting',
    gmailId: '', smtpAcceptedAt: '', humanReceivedOpened: false, zipSha256: '', zipBytes: 0,
    sourceBundle: process.env.SOURCE_BUNDLE_SHA256 ?? null, imageId: process.env.IMAGE_ID ?? null };
  // A nonce can never be rearmed after SMTP is entered. A stuck waiting listener with no send may resume.
  try {
    await writeFile(path, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(path, 'utf8')) as { state?: string; smtpAcceptedAt?: string; subject?: string };
    if (existing.state !== 'waiting' || existing.smtpAcceptedAt || existing.subject !== subject) {
      throw new Error('Nonce cannot be rearmed');
    }
    await writeFile(path, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  const save = async (state: string) => { evidence.state = state; await writeFile(path, JSON.stringify(evidence, null, 2), { mode: 0o600 }); };
  const client = imap(c);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      console.log(JSON.stringify({ event: 'probe-ready', to: c.GMAIL_ADDRESS, from: recipient, subject,
        instruction: 'Send this exact subject from the designated mailbox now. Sending triggers one automatic ZIP reply to that same mailbox.' }));
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        // Gmail does not expose new arrivals on a selected mailbox until NOOP/IDLE.
        await client.noop();
        const ids = await client.search({ since: coarseImapSince(since), from: recipient, header: { subject } }, { uid: true });
        for (const uid of (ids || []).slice(-20)) {
          const m = await client.fetchOne(uid, { uid: true, size: true, internalDate: true,
            headers: ['from', 'to', 'reply-to', 'subject', 'auto-submitted', 'list-id', 'return-path', 'message-id', 'references'] }, { uid: true });
          if (!m || !m.headers) continue;
          const headers = await simpleParser(m.headers);
          if (!probeMatch({ from: addresses(headers.from), to: addresses(headers.to), replyTo: addresses(headers.replyTo),
            subject: headers.subject ?? '', internalDate: new Date(m.internalDate ?? 0), size: m.size ?? 0,
            autoSubmitted: String(headers.headers.get('auto-submitted') ?? ''), listId: headers.headers.has('list-id'),
            returnPath: String(headers.headerLines.find(h => h.key === 'return-path')?.line.replace(/^return-path:/i, '').trim() ?? '') }, recipient, nonce, c.GMAIL_ADDRESS, since)) continue;
          if (!m.emailId || !/^\d+$/.test(m.emailId)) throw new Error('Stable Gmail message ID unavailable');
          const body = await client.fetchOne(uid, { source: { maxLength: 1_000_001 } }, { uid: true });
          if (!body || !body.source || body.source.length > 1_000_000) continue;
          // Read only this bounded matching message. Never use attachments, body addresses or URLs.
          const message = await simpleParser(body.source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
          if (message.subject !== subject || addresses(message.from).length !== 1 || addresses(message.from)[0]?.toLowerCase() !== recipient) continue;
          evidence.gmailId = m.emailId;
          const zip = await probeZip(nonce);
          evidence.zipBytes = zip.length; evidence.zipSha256 = createHash('sha256').update(zip).digest('hex');
          const transport = smtp(c);
          // Persist before entering SMTP; any crash/error after this point requires human review, never resend.
          await save('sending');
          try {
            const result = await transport.sendMail({
              from: c.GMAIL_ADDRESS, to: recipient, envelope: { from: c.GMAIL_ADDRESS, to: [recipient] },
              subject: `Re: ${subject}`, text: `Connectivity probe received. The attached ZIP contains probe.txt and your nonce ${nonce}. Please confirm that the ZIP arrived and opens.`,
              inReplyTo: message.messageId, references: message.messageId ? [message.messageId] : undefined,
              headers: { 'Auto-Submitted': 'auto-replied' },
              attachments: [{ filename: 'matter-mailer-probe.zip', content: zip, contentType: 'application/zip' }],
            });
            if (result.accepted.length !== 1 || result.rejected.length) throw new Error('SMTP acceptance incomplete');
            evidence.smtpAcceptedAt = new Date().toISOString();
            await save('smtp_accepted_receipt_pending');
            console.log(JSON.stringify({ event: 'probe-smtp-accepted', gmailId: evidence.gmailId, zipBytes: zip.length,
              zipSha256: evidence.zipSha256, humanReceivedOpened: false }));
            return;
          } catch (error) { await save('review_no_automatic_resend'); throw error; }
          finally { transport.close(); }
        }
        await delay(5_000);
      }
      await save('timeout_no_mail_sent');
      throw new Error('Probe wait expired; use a fresh random nonce');
    } finally { lock.release(); }
  } finally { if (client.usable) await client.logout().catch(() => client.close()); else client.close(); }
}
