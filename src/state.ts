import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MESSAGE_STATES = ['processing', 'sending', 'sent', 'ignored', 'failed', 'review'] as const;
export type MessageState = typeof MESSAGE_STATES[number];
export type TerminalInsert = 'processing' | 'ignored' | 'review';
export type SendAck = 'accepted' | 'rejected' | 'unknown';

export interface MessageRecord {
  gmailId: string;
  receivedAt: string;
  recipient: string | null;
  messageId: string | null;
  referencesHeader: string | null;
  subject: string | null;
  state: MessageState;
  outcome: string | null;
  error: string | null;
  resultJson: string | null;
  updatedAt: string;
}

export interface NewMessage {
  gmailId: string;
  receivedAt: string;
  recipient: string | null;
  messageId: string | null;
  referencesHeader: string | null;
  subject: string | null;
  state: TerminalInsert;
  outcome: string | null;
  error: string | null;
}

interface SqlMessage {
  gmail_id: string | number | bigint;
  received_at: string;
  recipient: string | null;
  message_id: string | null;
  references_header: string | null;
  subject: string | null;
  state: MessageState;
  outcome: string | null;
  error: string | null;
  result_json: string | null;
  updated_at: string;
}

function textId(value: string | number | bigint): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

function mapRow(row: SqlMessage): MessageRecord {
  return {
    gmailId: textId(row.gmail_id),
    receivedAt: row.received_at,
    recipient: row.recipient,
    messageId: row.message_id,
    referencesHeader: row.references_header,
    subject: row.subject,
    state: row.state,
    outcome: row.outcome,
    error: row.error,
    resultJson: row.result_json,
    updatedAt: row.updated_at,
  };
}

function isUnique(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function changed(result: { changes: number | bigint }): boolean {
  return Number(result.changes) === 1;
}

const COLUMNS = `gmail_id, received_at, recipient, message_id, references_header, subject, state, outcome, error, result_json, updated_at`;

export class Ledger {
  constructor(private readonly db: DatabaseSync) {}

  claim(message: NewMessage): 'claimed' | 'duplicate' {
    if (!/^\d{1,40}$/.test(message.gmailId)) throw new Error('Gmail ID must be a decimal string');
    try {
      this.db.prepare(`INSERT INTO messages (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
        message.gmailId, message.receivedAt, message.recipient, message.messageId, message.referencesHeader,
        message.subject, message.state, message.outcome, message.error, new Date().toISOString(),
      );
      return 'claimed';
    } catch (error) {
      if (isUnique(error)) return 'duplicate';
      throw error;
    }
  }

  get(gmailId: string): MessageRecord | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE gmail_id = ?`).get(gmailId) as SqlMessage | undefined;
    return row ? mapRow(row) : null;
  }

  has(gmailId: string): boolean {
    return this.get(gmailId) !== null;
  }

  beginSend(gmailId: string): void {
    const result = this.db.prepare(`UPDATE messages SET state = 'sending', updated_at = ? WHERE gmail_id = ? AND state = 'processing'`).run(new Date().toISOString(), gmailId);
    if (!changed(result)) throw new Error('Send boundary refused');
  }

  finishSend(gmailId: string, state: 'sent' | 'failed' | 'review', outcome: string, error: string | null, resultJson: string | null): void {
    const result = this.db.prepare(`UPDATE messages SET state = ?, outcome = ?, error = ?, result_json = ?, updated_at = ? WHERE gmail_id = ? AND state = 'sending'`).run(
      state, outcome, error, resultJson, new Date().toISOString(), gmailId,
    );
    if (!changed(result)) throw new Error('Send result refused');
  }

  failBeforeSend(gmailId: string, outcome: string, error: string): void {
    const result = this.db.prepare(`UPDATE messages SET state = 'failed', outcome = ?, error = ?, updated_at = ? WHERE gmail_id = ? AND state = 'processing'`).run(
      outcome, error, new Date().toISOString(), gmailId,
    );
    if (!changed(result)) throw new Error('Failure before send refused');
  }

  release(gmailId: string, state: 'ignored' | 'review', outcome: string): void {
    const result = this.db.prepare(`UPDATE messages SET state = ?, outcome = ?, error = NULL, updated_at = ? WHERE gmail_id = ? AND state = 'processing'`).run(
      state, outcome, new Date().toISOString(), gmailId,
    );
    if (!changed(result)) throw new Error('Ledger release refused');
  }

  markSendingReview(gmailId: string): void {
    this.db.prepare(`UPDATE messages SET state = 'review', outcome = 'smtp_unknown', error = ?, updated_at = ? WHERE gmail_id = ? AND state = 'sending'`).run(
      'sending interrupted; check Sent before any manual resend', new Date().toISOString(), gmailId,
    );
  }

  rowsIn(state: MessageState): MessageRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE state = ? ORDER BY received_at, gmail_id`).all(state) as unknown as SqlMessage[];
    return rows.map(mapRow);
  }

  inspect(): Omit<MessageRecord, 'resultJson'>[] {
    return this.rowsAll().map(({ resultJson: _result, ...row }) => row);
  }

  private rowsAll(): MessageRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM messages ORDER BY received_at, gmail_id`).all() as unknown as SqlMessage[];
    return rows.map(mapRow);
  }

  close(): void {
    this.db.close();
  }
}

export function openLedger(dataDir: string): Ledger {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'ledger.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    gmail_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    recipient TEXT,
    message_id TEXT,
    references_header TEXT,
    subject TEXT,
    state TEXT NOT NULL CHECK (state IN ('processing', 'sending', 'sent', 'ignored', 'failed', 'review')),
    outcome TEXT,
    error TEXT,
    result_json TEXT,
    updated_at TEXT NOT NULL
  )`);
  return new Ledger(db);
}

/** Sending rows become review with no mail. Processing rows still need one failure reply. */
export function classifyRestart(ledger: Ledger): MessageRecord[] {
  for (const row of ledger.rowsIn('sending')) ledger.markSendingReview(row.gmailId);
  return ledger.rowsIn('processing');
}
