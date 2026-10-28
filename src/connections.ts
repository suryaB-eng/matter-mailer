import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export function imap(c: Config) {
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: c.GMAIL_ADDRESS, pass: c.GMAIL_APP_PASSWORD },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'imap.gmail.com' },
    logger: false, connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 60_000,
  });
  // No raw server/auth/message details in logs. Awaited calls report sanitized failures.
  client.on('error', () => {});
  return client;
}
export function smtp(c: Config) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true,
    auth: { user: c.GMAIL_ADDRESS, pass: c.GMAIL_APP_PASSWORD },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'smtp.gmail.com' },
    connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 60_000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
  });
}
