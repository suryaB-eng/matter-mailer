import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yauzl from 'yauzl';
import type { RetrievedRecord, SavedComponent } from '../src/matter.js';
import { packageRecords, safeArchiveName, verifyFile } from '../src/zip.js';

function pdf(pad = 0): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'), Buffer.alloc(pad, 0x61), Buffer.from('\n%%EOF\n')]);
}

async function saved(dir: string, recordId: string, index: number, name: string, body: Buffer): Promise<SavedComponent> {
  const archiveName = safeArchiveName(recordId, index, name);
  const path = join(dir, archiveName);
  await writeFile(path, body);
  const checked = await verifyFile(path, name);
  return { index, originalName: name, archiveName, path, ...checked, status: 'verified' };
}

function record(recordId: string, order: number, components: SavedComponent[], status: RetrievedRecord['status'] = 'complete'): RetrievedRecord {
  return { recordId, order, status, components, failureReason: status === 'failed' ? 'At least one component failed; entire document record excluded.' : undefined };
}

async function readZip(path: string): Promise<{ name: string; bytes: number }[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const files: { name: string; bytes: number }[] = [];
      zip.on('error', reject);
      zip.on('entry', entry => zip.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) return reject(streamError);
        const parts: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => parts.push(chunk));
        stream.on('end', () => { files.push({ name: entry.fileName, bytes: Buffer.concat(parts).length }); zip.readEntry(); });
      }));
      zip.on('end', () => resolve(files));
      zip.readEntry();
    });
  });
}

test('duplicate source names stay unique and an incomplete multi-component record stays out of the ZIP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matter-zip-'));
  try {
    const filesDir = join(dir, 'files');
    await mkdir(filesDir);
    assert.notEqual(safeArchiveName('00880', 0, '../../same.pdf'), safeArchiveName('00880', 1, '../../same.pdf'));
    assert.doesNotMatch(safeArchiveName('00880', 0, '../../same.pdf'), /[\\/]/);
    const broken = record('00880', 0, [
      await saved(filesDir, '00880', 0, 'same.pdf', pdf()),
      { index: 1, originalName: 'same.pdf', archiveName: safeArchiveName('00880', 1, 'same.pdf'), path: null, bytes: null, sha256: null, status: 'failed', failureReason: 'HTML error page downloaded instead of a document' },
    ], 'failed');
    const intact = record('00881', 1, [await saved(filesDir, '00881', 0, '00881.pdf', pdf())]);
    const packed = await packageRecords({
      jobDir: dir, matter: 'M01234', category: 'Key Documents', snapshotMatterId: 'M01234', selectionMatterId: 'M01234',
      records: [broken, intact],
    });
    assert.equal(packed.includedRecordIds.join(), '00881');
    assert.match(packed.omissions[0]!.reason, /entire document record excluded/);
    assert.ok(packed.zipPath);
    const entries = await readZip(packed.zipPath!);
    assert.deepEqual(entries.map(entry => entry.name), intact.components.map(component => component.archiveName));
    assert.equal(entries[0]!.bytes, intact.components[0]!.bytes);
    assert.equal((await readFile(packed.zipPath!)).subarray(0, 2).toString(), 'PK');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ten-file boundary keeps a later fitting record and drops the group that would pass ten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matter-ten-'));
  try {
    const filesDir = join(dir, 'files');
    await mkdir(filesDir);
    const group = async (id: string, order: number, count: number) => record(id, order, await Promise.all(
      Array.from({ length: count }, (_, index) => saved(filesDir, id, index, `${id}-${index}.pdf`, pdf())),
    ));
    const packed = await packageRecords({
      jobDir: dir, matter: 'M01234', category: 'Other Documents', snapshotMatterId: 'M01234', selectionMatterId: 'M01234',
      records: [await group('A', 0, 6), await group('B', 1, 5), await group('C', 2, 4)],
    });
    assert.deepEqual(packed.includedRecordIds, ['A', 'C']);
    assert.equal(packed.fileCount, 10);
    assert.match(packed.omissions[0]!.reason, /ten-physical-file/);
    assert.equal((await readZip(packed.zipPath!)).length, 10);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('byte budget omits a later whole record and readback still matches the smaller ZIP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matter-bytes-'));
  try {
    const filesDir = join(dir, 'files');
    await mkdir(filesDir);
    const small = record('small', 0, [await saved(filesDir, 'small', 0, 'small.pdf', pdf())]);
    const large = record('large', 1, [await saved(filesDir, 'large', 0, 'large.pdf', pdf(20_000))]);
    const alone = await packageRecords({
      jobDir: dir, matter: 'M01234', category: 'Key Documents', snapshotMatterId: 'M01234', selectionMatterId: 'M01234', records: [small],
    });
    const packed = await packageRecords({
      jobDir: dir, matter: 'M01234', category: 'Key Documents', snapshotMatterId: 'M01234', selectionMatterId: 'M01234',
      records: [small, large], maxZipBytes: alone.zipBytes!,
    });
    assert.deepEqual(packed.includedRecordIds, ['small']);
    assert.match(packed.omissions[0]!.reason, /attachment budget/);
    assert.equal(packed.zipBytes, alone.zipBytes);
    assert.equal((await readZip(packed.zipPath!)).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
