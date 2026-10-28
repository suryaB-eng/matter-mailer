import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { OVERLAP_NOTE, parseRequest, type Category, type MatterSnapshot } from './matter.js';
import { downloadSelected, lookupMatter, selectRecords, UARB_URL } from './uarb.js';
import { packageRecords } from './zip.js';

export interface FetchReport {
  outcome: 'success' | 'partial' | 'empty' | 'not_found' | 'source_failure' | 'failed';
  matter: string;
  category: Category;
  url: string;
  observedAt: string | null;
  metadata: MatterSnapshot['metadata'];
  counts: MatterSnapshot['counts'] | null;
  overlap: string;
  foundCount: number | null;
  selectionComplete: boolean | null;
  selectedRecords: { recordId: string; order: number }[];
  files: { recordId: string; archiveName: string; path: string; bytes: number; sha256: string }[];
  omissions: { recordId: string | null; reason: string }[];
  zipPath: string | null;
  zipBytes: number | null;
  zipSha256: string | null;
  jobDir: string;
  mailSent: false;
  reason?: string;
}

function base(matter: string, category: Category, jobDir: string, extra: Partial<FetchReport> = {}): FetchReport {
  return {
    outcome: 'failed', matter, category, url: UARB_URL, observedAt: null, metadata: [], counts: null,
    overlap: OVERLAP_NOTE, foundCount: null, selectionComplete: null, selectedRecords: [], files: [],
    omissions: [], zipPath: null, zipBytes: null, zipSha256: null, jobDir, mailSent: false, ...extra,
  };
}

export async function runFetch(matterInput: string, categoryInput: string, dataDir: string, options?: { budgetMs?: number }): Promise<FetchReport> {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node 24 is required');
  const request = parseRequest(matterInput, categoryInput);
  const jobDir = join(dataDir, 'jobs', randomUUID());
  await mkdir(join(jobDir, 'files'), { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: true, chromiumSandbox: process.platform === 'linux', timeout: 30_000 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await browser.close().catch(() => undefined);
  };
  const timer = setTimeout(() => { void close(); }, options?.budgetMs ?? 10 * 60_000);
  try {
    const page = await browser.newPage({ acceptDownloads: true, ignoreHTTPSErrors: false });
    const lookup = await lookupMatter(page, request.matter);
    if (lookup.status === 'not_found') return base(request.matter, request.category, jobDir, { outcome: 'not_found', reason: lookup.reason });
    if (lookup.status !== 'found') return base(request.matter, request.category, jobDir, { outcome: 'source_failure', reason: lookup.reason });
    const snapshot = lookup.snapshot;
    const selected = await selectRecords(page, snapshot, request.category);
    const shared = {
      observedAt: snapshot.observedAt, metadata: snapshot.metadata, counts: snapshot.counts,
    };
    if (selected.status === 'source_failure') return base(request.matter, request.category, jobDir, { ...shared, outcome: 'source_failure', reason: selected.reason });
    if (selected.status === 'empty') {
      const report = base(request.matter, request.category, jobDir, {
        ...shared, outcome: 'empty', foundCount: 0, selectionComplete: true, reason: selected.selection.reason,
      });
      await writeFile(join(jobDir, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      return report;
    }
    const records = await downloadSelected(page, selected.selection, jobDir);
    const packed = await packageRecords({
      jobDir, matter: request.matter, category: request.category, snapshotMatterId: snapshot.matterId,
      selectionMatterId: selected.selection.matterId, records,
    });
    const files = records.filter(record => packed.includedRecordIds.includes(record.recordId)).flatMap(record => record.components
      .filter((component): component is typeof component & { path: string; bytes: number; sha256: string } => component.status === 'verified' && !!component.path && component.bytes !== null && !!component.sha256)
      .map(component => ({ recordId: record.recordId, archiveName: component.archiveName, path: component.path, bytes: component.bytes, sha256: component.sha256 })));
    const omissions = [
      ...(selected.selection.reason ? [{ recordId: null, reason: selected.selection.reason }] : []),
      ...packed.omissions,
    ];
    const downloadedAll = records.every(record => record.status === 'complete');
    const includedAll = records.every(record => packed.includedRecordIds.includes(record.recordId));
    let outcome: FetchReport['outcome'] = 'failed';
    if (packed.zipPath && selected.selection.complete && downloadedAll && includedAll && omissions.length === 0) outcome = 'success';
    else if (packed.zipPath) outcome = 'partial';
    const report = base(request.matter, request.category, jobDir, {
      ...shared, outcome, foundCount: selected.selection.foundCount, selectionComplete: selected.selection.complete,
      selectedRecords: selected.selection.records.map(record => ({ recordId: record.recordId, order: record.order })),
      files, omissions, zipPath: packed.zipPath, zipBytes: packed.zipBytes, zipSha256: packed.zipSha256,
      reason: outcome === 'failed' ? 'No verified files fit the archive.' : undefined,
    });
    await writeFile(join(jobDir, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    return report;
  } catch {
    const report = base(request.matter, request.category, jobDir, { outcome: 'failed', reason: 'Retrieval stopped before a verified archive was ready.' });
    await writeFile(join(jobDir, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 }).catch(() => undefined);
    return report;
  } finally {
    clearTimeout(timer);
    await close();
  }
}
