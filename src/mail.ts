import { once } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { simpleParser, type AddressObject } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { SendMailOptions } from 'nodemailer';
import type { ImapFlow } from 'imapflow';
import { z } from 'zod';
import type { Config } from './config.js';
import { smtp } from './connections.js';
import { coarseImapSince } from './probe-policy.js';

export const MAX_INCOMING_BYTES = 1_000_000;
export const MAX_MIME_BYTES = 30_000_000;
export type SendAck = 'accepted' | 'rejected' | 'unknown';

export interface HeaderView {
  subject: string;
  from: string[];
  replyTo: string[];
  size: number;
  autoSubmitted: string;
  listId: boolean;
  returnPath: string;
}

export type HeaderDecision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'hold'; reason: string }
  | { kind: 'oversized'; recipient: string }
  | { kind: 'read'; recipient: string };

export interface ListedMessage extends HeaderView {
  uid: number;
  gmailId: string;
  internalDate: string;
  to: string[];
  messageId: string | null;
  references: string | null;
}

export interface Outgoing {
  recipient: string;
  subject: string;
  text: string;
  messageId: string | null;
  references: string | null;
  attachment: { filename: string; content: Buffer } | null;
}

function mailboxes(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const address = value.trim().toLowerCase();
    if (!address || /[\s<>,;]/.test(address) || !z.email().safeParse(address).success) continue;
    seen.add(address);
  }
  return [...seen];
}

export function isProbeSubject(subject: string): boolean {
  return /^(?:re:\s*)*matter-mailer probe [a-f0-9]{32,64}$/i.test(subject.trim());
}

export function classifyHeader(message: HeaderView, agent: string): HeaderDecision {
  if (/[\r\n]/.test(message.subject)) return { kind: 'hold', reason: 'unsafe-subject' };
  if (isProbeSubject(message.subject)) return { kind: 'ignore', reason: 'probe' };
  const auto = message.autoSubmitted.trim().toLowerCase();
  if (auto && auto !== 'no') return { kind: 'ignore', reason: 'auto' };
  if (message.listId) return { kind: 'ignore', reason: 'list' };
  if (message.returnPath.trim() === '<>') return { kind: 'ignore', reason: 'bounce' };
  const from = mailboxes(message.from);
  const replyTo = mailboxes(message.replyTo);
  const self = agent.trim().toLowerCase();
  if (from.includes(self) || replyTo.includes(self)) return { kind: 'ignore', reason: 'self' };
  let recipient: string | null = null;
  if (replyTo.length > 1 || (replyTo.length === 0 && from.length > 1)) return { kind: 'hold', reason: 'ambiguous' };
  if (replyTo.length === 1) recipient = replyTo[0] ?? null;
  else recipient = from[0] ?? null;
  if (!recipient || recipient === self) return { kind: 'hold', reason: 'missing' };
  if (message.size > MAX_INCOMING_BYTES) return { kind: 'oversized', recipient };
  return { kind: 'read', recipient };
}

export function replySubject(subject: string): string {
  const clean = subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
  if (!clean) return 'Re: document request';
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

export function archiveFilename(matter: string, category: string): string {
  if (!/^M[0-9]{5}$/.test(matter)) throw new Error('Matter must be M followed by exactly five digits');
  const slug = category.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  return `${matter}-${slug || 'documents'}.zip`;
}

export function mimeLimit(advertised: number | null): number {
  if (advertised == null || !Number.isSafeInteger(advertised) || advertised <= 0) return MAX_MIME_BYTES;
  return Math.min(MAX_MIME_BYTES, advertised);
}

export function withinMimeLimit(bytes: number, advertised: number | null): boolean {
  return bytes <= mimeLimit(advertised);
}

function referenceList(references: string | null, messageId: string | null): string[] | undefined {
  const ids = `${references ?? ''} ${messageId ?? ''}`.match(/<[^<>\s]+>/g);
  return ids?.length ? [...new Set(ids)].slice(-8) : undefined;
}

function toOptions(agent: string, mail: Outgoing): SendMailOptions {
  return {
    from: agent,
    to: mail.recipient,
    envelope: { from: agent, to: [mail.recipient] },
    subject: mail.subject,
    text: mail.text,
    inReplyTo: mail.messageId ?? undefined,
    references: referenceList(mail.references, mail.messageId),
    headers: { 'Auto-Submitted': 'auto-replied' },
    attachments: mail.attachment ? [{ filename: mail.attachment.filename, content: mail.attachment.content, contentType: 'application/zip' }] : [],
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export async function renderMime(agent: string, mail: Outgoing): Promise<Buffer> {
  return new MailComposer(toOptions(agent, mail)).compile().build();
}

export async function fitReply(agent: string, mail: Outgoing, advertised: number | null): Promise<{ mail: Outgoing; droppedZip: boolean; blocked: boolean }> {
  if ((await renderMime(agent, mail)).length <= mimeLimit(advertised)) return { mail, droppedZip: false, blocked: false };
  if (!mail.attachment) return { mail, droppedZip: false, blocked: true };
  const without: Outgoing = {
    ...mail,
    attachment: null,
    text: `${mail.text}\n\nThe archive was omitted because the assembled message exceeded the mail size limit.`,
  };
  if ((await renderMime(agent, without)).length <= mimeLimit(advertised)) return { mail: without, droppedZip: true, blocked: false };
  return { mail: without, droppedZip: true, blocked: true };
}

export function classifySendError(error: unknown): 'rejected' | 'unknown' {
  const value = error as { responseCode?: unknown; code?: unknown };
  const responseCode = typeof value.responseCode === 'number' ? value.responseCode : 0;
  if (responseCode >= 500 && responseCode <= 599) return 'rejected';
  if (value.code === 'EENVELOPE' || value.code === 'EMESSAGE') return 'rejected';
  return 'unknown';
}

export async function deliverReply(config: Config, mail: Outgoing): Promise<SendAck> {
  const transport = smtp(config);
  try {
    const result = await transport.sendMail(toOptions(config.GMAIL_ADDRESS, mail));
    const accepted = Array.isArray(result.accepted) ? result.accepted.length : 0;
    const rejected = Array.isArray(result.rejected) ? result.rejected.length : 0;
    if (rejected || accepted !== 1) return 'rejected';
    return 'accepted';
  } catch (error) {
    return classifySendError(error);
  } finally {
    transport.close();
  }
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  return mailboxes((Array.isArray(value) ? value : value ? [value] : []).flatMap(item => item.value.map(entry => entry.address ?? '')));
}

function bracketId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^<[^<>\s]+>$/.test(trimmed)) return trimmed;
  if (/^[^\s<>]+$/.test(trimmed) && trimmed.includes('@')) return `<${trimmed}>`;
  return null;
}

function bracketReferences(value: string | string[] | undefined): string | null {
  const joined = Array.isArray(value) ? value.join(' ') : value ?? '';
  const ids = joined.match(/<[^<>\s]+>/g) ?? joined.split(/\s+/).filter(part => part.includes('@') && !/[\s<>]/.test(part)).map(part => `<${part}>`);
  return ids.length ? ids.slice(-8).join(' ') : null;
}

export async function listEligible(client: ImapFlow, start: Date): Promise<ListedMessage[]> {
  const uids = await client.search({ since: coarseImapSince(start) }, { uid: true });
  const found: ListedMessage[] = [];
  for (const uid of (uids || []).slice(0, 300)) {
    const message = await client.fetchOne(uid, {
      uid: true, size: true, internalDate: true,
      headers: ['from', 'to', 'reply-to', 'subject', 'auto-submitted', 'list-id', 'return-path', 'message-id', 'references'],
    }, { uid: true });
    if (message === false || !message.headers || !message.internalDate || !message.emailId || !/^\d{1,40}$/.test(message.emailId)) continue;
    const internal = new Date(message.internalDate);
    if (!Number.isFinite(internal.getTime()) || internal.getTime() < start.getTime()) continue;
    const headers = await simpleParser(message.headers);
    found.push({
      uid: message.uid,
      gmailId: message.emailId,
      internalDate: internal.toISOString(),
      size: message.size ?? 0,
      subject: headers.subject ?? '',
      from: addresses(headers.from),
      replyTo: addresses(headers.replyTo),
      to: addresses(headers.to),
      messageId: bracketId(headers.messageId),
      references: bracketReferences(headers.references),
      autoSubmitted: String(headers.headers.get('auto-submitted') ?? ''),
      listId: headers.headers.has('list-id'),
      returnPath: String(headers.headerLines.find(header => header.key === 'return-path')?.line.replace(/^return-path:/i, '').trim() ?? ''),
    });
  }
  found.sort((left, right) => left.internalDate.localeCompare(right.internalDate) || left.uid - right.uid);
  return found;
}

export async function readBody(client: ImapFlow, uid: number): Promise<string> {
  const message = await client.fetchOne(uid, { source: { maxLength: MAX_INCOMING_BYTES + 1 } }, { uid: true });
  if (message === false || !message.source || message.source.length > MAX_INCOMING_BYTES) throw new Error('OVERSIZED');
  const parsed = await simpleParser(message.source, { skipImageLinks: true });
  return (parsed.text ?? '').replace(/\u0000/g, '');
}

function sizeFrom(text: string): number | null {
  const match = text.match(/^250[ -]SIZE (\d+)/im);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readSmtp(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (error: Error | null, value = '') => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error('SMTP_CLOSED'));
    const onData = (chunk: Buffer) => {
      data += chunk.toString('latin1');
      if (data.length > 16_000) return finish(new Error('SMTP_BANNER'));
      const lines = data.split(/\r?\n/).filter(Boolean);
      if (lines.at(-1)?.match(/^\d{3} /)) finish(null, data);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

export async function advertisedSmtpSize(): Promise<number | null> {
  const plain = net.connect({ host: 'smtp.gmail.com', port: 587 });
  plain.setTimeout(10_000);
  plain.on('timeout', () => plain.destroy());
  let secure: tls.TLSSocket | null = null;
  try {
    const greeting = await readSmtp(plain);
    if (!greeting.startsWith('220')) return null;
    plain.write('EHLO matter-mailer.local\r\n');
    const first = await readSmtp(plain);
    let text = first;
    if (/^250[ -]STARTTLS/im.test(first)) {
      plain.write('STARTTLS\r\n');
      const ready = await readSmtp(plain);
      if (!ready.startsWith('220')) return sizeFrom(first);
      secure = tls.connect({ socket: plain, servername: 'smtp.gmail.com', rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      secure.setTimeout(10_000);
      secure.on('timeout', () => secure?.destroy());
      await once(secure, 'secureConnect');
      secure.write('EHLO matter-mailer.local\r\n');
      text = await readSmtp(secure);
      secure.end('QUIT\r\n');
    } else plain.end('QUIT\r\n');
    return sizeFrom(text) ?? sizeFrom(first);
  } catch {
    return null;
  } finally {
    secure?.destroy();
    plain.destroy();
  }
}
