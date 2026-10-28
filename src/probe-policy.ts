import { z } from 'zod';

function mailbox(value: string): string {
  if (/[\s<>,;\r\n]/.test(value) || !z.email().safeParse(value).success) throw new Error('One explicit bare mailbox is required');
  return value.toLowerCase();
}
export function validateProbeArgs(recipient: string, nonce: string, agent: string) {
  const address = mailbox(recipient);
  if (address === mailbox(agent)) throw new Error('Probe needs a separate mailbox');
  if (!/^[a-f0-9]{32,64}$/.test(nonce)) throw new Error('Nonce must be 16–32 random bytes encoded as lowercase hex');
  return { recipient: address, nonce };
}
export function probeSubject(nonce: string) { return `matter-mailer probe ${nonce}`; }
// IMAP SINCE is a timezone-naive date. Gmail compared this message as 27 Oct local
// while the UTC timestamp was already 28 Oct, so an exact UTC day is too strict.
export function coarseImapSince(start: Date): Date {
  if (!Number.isFinite(start.getTime())) throw new Error('Invalid search start');
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - 1));
}
export type ProbeHeaders = {
  from: string[]; to: string[]; replyTo: string[]; subject: string;
  internalDate: Date; size: number; autoSubmitted: string; listId: boolean; returnPath: string;
};
export function probeMatch(m: ProbeHeaders, recipient: string, nonce: string, agent: string, start: Date): boolean {
  return m.from.length === 1 && m.from[0]?.toLowerCase() === recipient.toLowerCase()
    && m.to.some(a => a.toLowerCase() === agent.toLowerCase())
    && m.replyTo.length <= 1 && (!m.replyTo.length || m.replyTo[0]?.toLowerCase() === recipient.toLowerCase())
    && m.subject === probeSubject(nonce) && Number.isFinite(m.internalDate.getTime())
    && m.internalDate.getTime() >= start.getTime() && m.size > 0 && m.size <= 1_000_000
    && (!m.autoSubmitted || m.autoSubmitted.toLowerCase() === 'no') && !m.listId && m.returnPath.trim() !== '<>';
}
