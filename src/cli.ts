import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { doctor, safeError } from './doctor.js';
import { runFetch } from './fetch.js';
import { probe } from './probe.js';
import { openLedger } from './state.js';

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      live: { type: 'boolean' }, recipient: { type: 'string' }, nonce: { type: 'string' },
      matter: { type: 'string' }, category: { type: 'string' },
    },
    allowPositionals: true, strict: true,
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !command || !['doctor', 'probe', 'fetch', 'inspect'].includes(command)) {
    throw new Error('Use doctor --live, probe --recipient <mailbox> --nonce <random-hex>, fetch --matter M01234 --category "Key Documents", or inspect');
  }
  if (command === 'fetch') {
    if (values.live || values.recipient || values.nonce) throw new Error('fetch never sends mail');
    if (!values.matter || !values.category) throw new Error('fetch requires --matter and --category');
    const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
    if (!isAbsolute(dataDir)) throw new Error('DATA_DIR must be absolute');
    const report = await runFetch(values.matter, values.category, dataDir);
    console.log(JSON.stringify(report));
    if (report.outcome === 'source_failure' || report.outcome === 'failed') process.exitCode = 1;
    return;
  }
  const c = loadConfig();
  if (command === 'inspect') {
    if (values.live || values.recipient || values.nonce || values.matter || values.category) throw new Error('inspect reads the ledger only');
    const ledger = openLedger(c.DATA_DIR);
    try { console.log(JSON.stringify(ledger.inspect())); }
    finally { ledger.close(); }
    return;
  }
  if (command === 'doctor') {
    if (values.recipient || values.nonce || values.matter || values.category) throw new Error('doctor never sends mail');
    if (!await doctor(c, values.live ?? false)) process.exitCode = 1;
    return;
  }
  if (values.live || values.matter || values.category || !values.recipient || !values.nonce) throw new Error('probe requires explicit --recipient and --nonce');
  await probe(c, values.recipient, values.nonce);
}
main().catch(error => {
  const message = error instanceof Error && (/^(Invalid configuration:|MAIL_START_AT|Node 24|Use doctor|probe requires|doctor never|fetch never|fetch requires|inspect reads|DATA_DIR|Matter must|Category must)/.test(error.message)) ? error.message : safeError(error);
  console.error(JSON.stringify({ status: 'BLOCKED', error: message })); process.exitCode = 1;
});
