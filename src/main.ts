import { readFile, rm, stat, statfs } from 'node:fs/promises';
import { relative, resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, type Config } from './config.js';
import { imap } from './connections.js';
import { safeError } from './doctor.js';
import { runFetch, type FetchReport } from './fetch.js';
import { geminiInterpreter, interpretMessage, type ModelFn } from './interpret.js';
import {
  advertisedSmtpSize, archiveFilename, classifyHeader, deliverReply, fitReply, listEligible, readBody, replySubject,
  type HeaderDecision, type ListedMessage, type Outgoing,
} from './mail.js';
import { MAX_ZIP_BYTES } from './matter.js';
import { renderClarify, renderFetch, renderInterrupted, renderSystem } from './reply.js';
import { classifyRestart, openLedger, type Ledger, type MessageRecord, type NewMessage } from './state.js';

const IDLE_MS = 30_000;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

function isAuth(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code ?? '');
  return code === 'AUTHENTICATIONFAILED' || code === 'EAUTH' || /authentication failed/i.test(error instanceof Error ? error.message : '');
}

async function hasDisk(path: string): Promise<boolean> {
  const stats = await statfs(path);
  return BigInt(stats.bavail) * BigInt(stats.bsize) >= 1_000_000_000n;
}

async function removeJobs(dataDir: string): Promise<void> {
  await rm(join(dataDir, 'jobs'), { recursive: true, force: true });
}

async function removeOneJob(dataDir: string, jobDir: string): Promise<void> {
  const root = resolve(dataDir, 'jobs');
  const target = resolve(jobDir);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..')) return;
  await rm(target, { recursive: true, force: true });
}

function claimFrom(message: ListedMessage, recipient: string | null, state: NewMessage['state'], outcome: string | null, error: string | null = null): NewMessage {
  return {
    gmailId: message.gmailId,
    receivedAt: message.internalDate,
    recipient,
    messageId: message.messageId,
    referencesHeader: message.references,
    subject: message.subject.replace(/[\r\n]+/g, ' ').slice(0, 500),
    state,
    outcome,
    error,
  };
}

function outgoing(row: { recipient: string; subject: string | null; messageId: string | null; referencesHeader: string | null }, text: string, attachment: Outgoing['attachment'] = null): Outgoing {
  return {
    recipient: row.recipient,
    subject: replySubject(row.subject ?? ''),
    text,
    messageId: row.messageId,
    references: row.referencesHeader,
    attachment,
  };
}

async function guardedSend(config: Config, ledger: Ledger, gmailId: string, mail: Outgoing, onAccepted: 'sent' | 'failed', outcome: string, resultJson: string | null, advertised: number | null): Promise<void> {
  const fitted = await fitReply(config.GMAIL_ADDRESS, mail, advertised);
  const finalOutcome = fitted.droppedZip ? `${outcome}_mime_omitted` : outcome;
  if (fitted.blocked) {
    ledger.failBeforeSend(gmailId, finalOutcome, 'mime_too_large');
    log('reply-blocked', { gmailId, outcome: finalOutcome });
    return;
  }
  ledger.beginSend(gmailId);
  const ack = await deliverReply(config, fitted.mail);
  if (ack === 'accepted') ledger.finishSend(gmailId, onAccepted, finalOutcome, null, resultJson);
  else if (ack === 'rejected') ledger.finishSend(gmailId, 'failed', finalOutcome, 'smtp_rejected', resultJson);
  else ledger.finishSend(gmailId, 'review', finalOutcome, 'smtp_unknown', resultJson);
  log('reply-result', { gmailId, ack, outcome: finalOutcome });
}

async function sendInterrupted(config: Config, ledger: Ledger, row: MessageRecord, advertised: number | null): Promise<void> {
  if (!row.recipient) {
    ledger.failBeforeSend(row.gmailId, 'interrupted', 'no_recipient');
    return;
  }
  await guardedSend(config, ledger, row.gmailId, outgoing({
    recipient: row.recipient, subject: row.subject, messageId: row.messageId, referencesHeader: row.referencesHeader,
  }, renderInterrupted()), 'failed', 'interrupted', null, advertised);
}

function summary(report: FetchReport): string {
  return JSON.stringify({
    outcome: report.outcome, matter: report.matter, category: report.category, counts: report.counts,
    selected: report.selectedRecords.length, files: report.files.length, zipBytes: report.zipBytes,
    zipSha256: report.zipSha256, omissions: report.omissions,
  }).slice(0, 8_000);
}

async function loadAttachment(dataDir: string, report: FetchReport): Promise<Outgoing['attachment']> {
  if (!report.zipPath || !report.zipBytes || report.zipBytes > MAX_ZIP_BYTES) return null;
  const root = resolve(dataDir, 'jobs');
  const target = resolve(report.zipPath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..')) return null;
  const info = await stat(target);
  if (!info.isFile() || info.size !== report.zipBytes || info.size > MAX_ZIP_BYTES) return null;
  return { filename: archiveFilename(report.matter, report.category), content: await readFile(target) };
}

async function settle(config: Config, ledger: Ledger, model: ModelFn, message: ListedMessage, header: HeaderDecision, body: string | null, advertised: number | null): Promise<void> {
  if (header.kind === 'ignore') {
    if (ledger.claim(claimFrom(message, null, 'ignored', header.reason)) === 'claimed') log('ignored', { gmailId: message.gmailId, outcome: header.reason });
    return;
  }
  if (header.kind === 'hold') {
    if (ledger.claim(claimFrom(message, null, 'review', header.reason, 'held')) === 'claimed') log('held', { gmailId: message.gmailId, outcome: header.reason });
    return;
  }
  const recipient = header.recipient;
  if (ledger.claim(claimFrom(message, recipient, 'processing', null)) === 'duplicate') return;
  const row = { recipient, subject: message.subject, messageId: message.messageId, referencesHeader: message.references };
  if (header.kind === 'oversized' || body === null) {
    await guardedSend(config, ledger, message.gmailId, outgoing(row, renderClarify('oversized')), 'sent', 'oversized', null, advertised);
    return;
  }
  const decision = await interpretMessage(message.subject, body, model);
  if (decision.kind === 'ignore') {
    ledger.release(message.gmailId, 'ignored', decision.reason);
    log('ignored', { gmailId: message.gmailId, outcome: decision.reason });
    return;
  }
  if (decision.kind === 'clarify') {
    await guardedSend(config, ledger, message.gmailId, outgoing(row, renderClarify(decision.reason)), 'sent', 'clarify', null, advertised);
    return;
  }
  if (decision.kind === 'systemError') {
    await guardedSend(config, ledger, message.gmailId, outgoing(row, renderSystem(decision.reason)), 'sent', 'system_error', null, advertised);
    return;
  }
  if (!await hasDisk(config.DATA_DIR)) {
    await guardedSend(config, ledger, message.gmailId, outgoing(row, 'Not enough free disk to retrieve documents.\nNo archive is attached.'), 'sent', 'disk', null, advertised);
    return;
  }
  const started = Date.now();
  const report = await runFetch(decision.matter, decision.category, config.DATA_DIR, { budgetMs: 10 * 60_000 });
  const rendered = renderFetch(report);
  const attachment = rendered.attachZip ? await loadAttachment(config.DATA_DIR, report) : null;
  const text = attachment || !rendered.attachZip ? rendered.text : `${rendered.text}\n\nNo archive is attached because the file failed a final check.`;
  await guardedSend(config, ledger, message.gmailId, outgoing(row, text, attachment), 'sent', report.outcome, summary(report), advertised);
  await removeOneJob(config.DATA_DIR, report.jobDir);
  log('request-finished', { gmailId: message.gmailId, outcome: report.outcome, durationMs: Date.now() - started });
}

async function takeNext(config: Config, ledger: Ledger): Promise<{ message: ListedMessage; header: HeaderDecision; body: string | null } | null> {
  const client = imap(config);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      await client.noop();
      const messages = await listEligible(client, new Date(config.MAIL_START_AT));
      const message = messages.find(candidate => !ledger.has(candidate.gmailId));
      if (!message) return null;
      let header = classifyHeader(message, config.GMAIL_ADDRESS);
      let body: string | null = null;
      if (header.kind === 'read') {
        try { body = await readBody(client, message.uid); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'OVERSIZED') throw error;
          header = { kind: 'oversized', recipient: header.recipient };
        }
      }
      return { message, header, body };
    } finally { lock.release(); }
  } finally {
    if (client.usable) await client.logout().catch(() => client.close());
    else client.close();
  }
}

async function recover(config: Config, ledger: Ledger, stop: AbortSignal): Promise<number | null> {
  const pending = classifyRestart(ledger);
  log('restart-classified', { interruptedProcessing: pending.length });
  const advertised = await advertisedSmtpSize();
  for (const row of pending) {
    if (stop.aborted) break;
    try { await sendInterrupted(config, ledger, row, advertised); }
    catch (error) {
      log('interrupt-reply-failed', { gmailId: row.gmailId, error: safeError(error) });
      const current = ledger.get(row.gmailId);
      if (current?.state === 'sending') ledger.markSendingReview(row.gmailId);
    }
  }
  await removeJobs(config.DATA_DIR);
  return advertised;
}

export async function runAgent(config: Config): Promise<void> {
  const ledger = openLedger(config.DATA_DIR);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const model = geminiInterpreter(config);
  let authWaits = 0;
  try {
    let advertised: number | null = null;
    try { advertised = await recover(config, ledger, controller.signal); }
    catch (error) { log('startup-error', { error: safeError(error) }); }
    log('agent-ready', { idleSeconds: IDLE_MS / 1000, smtpSize: advertised });
    while (!controller.signal.aborted) {
      let gmailId = '';
      try {
        const next = await takeNext(config, ledger);
        authWaits = 0;
        if (!next) {
          await delay(IDLE_MS, undefined, { signal: controller.signal }).catch(() => undefined);
          continue;
        }
        gmailId = next.message.gmailId;
        if (advertised == null) advertised = await advertisedSmtpSize();
        await settle(config, ledger, model, next.message, next.header, next.body, advertised);
      } catch (error) {
        if (controller.signal.aborted) break;
        if (gmailId) {
          log('request-error', { gmailId, error: safeError(error) });
          const row = ledger.get(gmailId);
          if (row?.state === 'sending') ledger.markSendingReview(gmailId);
          else if (row?.state === 'processing') {
            try { await sendInterrupted(config, ledger, row, advertised); }
            catch (replyError) {
              log('interrupt-reply-failed', { gmailId, error: safeError(replyError) });
              if (ledger.get(gmailId)?.state === 'sending') ledger.markSendingReview(gmailId);
            }
          }
          continue;
        }
        const auth = isAuth(error);
        log(auth ? 'auth-failure' : 'poll-error', { error: safeError(error) });
        const wait = auth ? Math.min(5 * 60_000, 60_000 * ++authWaits) : IDLE_MS;
        await delay(wait, undefined, { signal: controller.signal }).catch(() => undefined);
      }
    }
  } finally {
    ledger.close();
    log('agent-stopped');
  }
}

async function entry(): Promise<void> {
  let config: Config;
  try { config = loadConfig(); }
  catch (error) {
    log('config-blocked', { error: error instanceof Error ? error.message : 'CHECK_FAILED' });
    await new Promise<void>(resolve => {
      const done = () => resolve();
      process.once('SIGTERM', done);
      process.once('SIGINT', done);
    });
    return;
  }
  await runAgent(config);
}

entry().catch(error => {
  log('agent-exit', { error: safeError(error) });
  process.exitCode = 1;
});
