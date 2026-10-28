import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { chromium } from 'playwright';
import { imap, smtp } from './connections.js';
import type { Config } from './config.js';
import { UARB_URL } from './uarb.js';
export async function checkChromium() {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 30_000 });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: false });
    const response = await page.goto(UARB_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!response?.ok() || new URL(page.url()).hostname !== 'uarb.novascotia.ca') throw new Error();
    await page.getByText('Go Directly to Matter', { exact: false }).first().waitFor({ timeout: 60_000 });
    return { browser: browser.version(), url: UARB_URL, http: response.status(), visible: 'Go Directly to Matter' };
  } finally { await browser.close(); }
}
export function safeError(error: unknown): string {
  const e = error as { code?: unknown; status?: unknown };
  const code = typeof e?.code === 'string' && /^[A-Z_0-9]{1,40}$/.test(e.code) ? e.code : undefined;
  const status = typeof e?.status === 'number' ? `HTTP_${e.status}` : undefined;
  return code ?? status ?? 'CHECK_FAILED';
}
export async function doctor(c: Config, live: boolean) {
  const checks: { name: string; status: 'PASS' | 'BLOCKED'; detail: unknown }[] = [];
  async function check(name: string, fn: () => Promise<unknown>) {
    try { checks.push({ name, status: 'PASS', detail: await fn() }); }
    catch (error) { checks.push({ name, status: 'BLOCKED', detail: safeError(error) }); }
    console.log(JSON.stringify(checks.at(-1)));
  }
  await check('data', async () => {
    await mkdir(c.DATA_DIR, { recursive: true, mode: 0o700 });
    const path = join(c.DATA_DIR, `.doctor-${randomUUID()}`);
    try { await writeFile(path, 'read-write', { flag: 'wx', mode: 0o600 }); if (await readFile(path, 'utf8') !== 'read-write') throw new Error(); }
    finally { await unlink(path).catch(() => {}); }
    return 'write/read/delete succeeded';
  });
  if (live) {
    await check('gmail-imap-993', async () => {
      const client = imap(c);
      try { await client.connect(); const folders = await client.list(); if (!folders.some(f => f.path === 'INBOX')) throw new Error(); return 'TLS certificate verified; authenticated; INBOX listed'; }
      finally { if (client.usable) await client.logout().catch(() => client.close()); else client.close(); }
    });
    await check('gmail-smtp-587', async () => {
      const transport = smtp(c);
      try { await transport.verify(); return 'required STARTTLS, certificate verification and authentication passed; no mail sent'; }
      finally { transport.close(); }
    });
    await check('gemini-structured', async () => {
      const ai = new GoogleGenAI({ apiKey: c.GEMINI_API_KEY, httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } } });
      const model = await ai.models.get({ model: c.GEMINI_MODEL });
      if (!model.supportedActions?.includes('generateContent')) throw new Error('Model cannot generate content');
      const expected = z.object({ matter: z.literal('M01234'), category: z.literal('Key Documents') }).strict();
      const response = await ai.models.generateContent({
        model: c.GEMINI_MODEL,
        contents: 'Extract the matter and document category from this synthetic connectivity test: Please send the Key Documents for matter M01234.',
        config: { responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(expected), maxOutputTokens: 256 },
      });
      expected.parse(JSON.parse(response.text ?? ''));
      return { model: model.name, extraction: 'validated M01234 / Key Documents', billing: 'free pricing/project status must also be verified by operator; API success alone does not establish billing' };
    });
    await check('chromium-uarb', checkChromium);
  }
  const report = { at: new Date().toISOString(), host: hostname(), platform: process.platform, architecture: process.arch,
    uid: process.getuid?.(), node: process.version, live, mailSent: false,
    sourceBundle: process.env.SOURCE_BUNDLE_SHA256 ?? null, imageId: process.env.IMAGE_ID ?? null, checks };
  const evidence = join(c.DATA_DIR, 'evidence');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await writeFile(join(evidence, `doctor-${Date.now()}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  return checks.every(c => c.status === 'PASS');
}
