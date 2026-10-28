import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { assertMatterIdentity, MAX_PHYSICAL_FILES, MAX_ZIP_BYTES, type Category, type RetrievedRecord, type SavedComponent } from './matter.js';

export class ZipBudgetError extends Error {}

export function safeArchiveName(recordId: string, index: number, originalName: string): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid component index');
  const leaf = basename(originalName.replace(/\\/g, '/'));
  const extension = extname(leaf).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 16);
  const clean = (value: string, length: number) => value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, length) || 'file';
  const stem = leaf.slice(0, extension ? -extname(leaf).length : undefined);
  const identity = createHash('sha256').update(recordId).digest('hex').slice(0, 16);
  return `${clean(recordId, 32)}_${identity}_${index + 1}_${clean(stem, 70)}${extension}`;
}

export async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}

export async function verifyFile(path: string, name: string): Promise<{ bytes: number; sha256: string }> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error('Empty or non-file download');
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(Math.min(4096, info.size));
    await handle.read(header, 0, header.length, 0);
    const text = header.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(text)) throw new Error('HTML error page downloaded instead of a document');
    const extension = extname(name).toLowerCase();
    if (extension === '.pdf') {
      const tail = Buffer.alloc(Math.min(2048, info.size));
      await handle.read(tail, 0, tail.length, info.size - tail.length);
      if (!/^%PDF-[12]\.\d/.test(header.toString('latin1')) || !/%%EOF\s*$/.test(tail.toString('latin1'))) throw new Error('Invalid or truncated PDF signature/EOF');
    }
    const prefix = header.subarray(0, 8).toString('hex');
    if (['.zip', '.docx', '.xlsx', '.pptx'].includes(extension) && !prefix.startsWith('504b0304') && !prefix.startsWith('504b0506')) throw new Error('Invalid ZIP-based file signature');
    if (['.doc', '.xls', '.ppt'].includes(extension) && prefix !== 'd0cf11e0a1b11ae1') throw new Error('Invalid Office binary signature');
    if (extension === '.png' && prefix !== '89504e470d0a1a0a') throw new Error('Invalid PNG signature');
    if (['.jpg', '.jpeg'].includes(extension) && !prefix.startsWith('ffd8ff')) throw new Error('Invalid JPEG signature');
    if (extension === '.mp3' && header.subarray(0, 3).toString('ascii') !== 'ID3'
      && !(header[0] === 0xff && ((header[1] ?? 0) & 0xe0) === 0xe0)) throw new Error('Invalid MP3 signature');
  } finally { await handle.close(); }
  return hashFile(path);
}

async function readBack(path: string, files: SavedComponent[]): Promise<void> {
  const expected = new Map(files.map(file => [file.archiveName, file]));
  if (expected.size !== files.length) throw new Error('Duplicate archive names');
  await new Promise<void>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('Cannot read ZIP'));
      const seen = new Set<string>();
      const fail = (cause: unknown) => { zip.close(); reject(cause); };
      zip.on('error', fail);
      zip.on('entry', entry => {
        const file = expected.get(entry.fileName);
        if (!file || seen.has(entry.fileName) || /[\\/]/.test(entry.fileName)) return fail(new Error('Unexpected/duplicate/unsafe ZIP entry'));
        seen.add(entry.fileName);
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error('Missing ZIP stream'));
          const hash = createHash('sha256');
          let bytes = 0;
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => { hash.update(chunk); bytes += chunk.length; });
          stream.on('end', () => {
            if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) return fail(new Error('ZIP readback hash/size mismatch'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => seen.size === files.length ? resolve() : reject(new Error('ZIP entry count mismatch')));
      zip.readEntry();
    });
  });
}

async function buildZip(jobDir: string, matter: string, records: RetrievedRecord[], maxZipBytes: number) {
  const files: SavedComponent[] = [];
  const names = new Set<string>();
  const root = await realpath(jobDir);
  for (const record of records) {
    if (record.status !== 'complete' || !record.components.length || record.components.some(file => file.status !== 'verified')) {
      throw new Error('Incomplete record cannot be archived');
    }
    for (const file of record.components) {
      if (!file.path || !file.sha256 || !file.bytes || names.has(file.archiveName) || !/^[A-Za-z0-9_-]+(?:\.[a-z0-9]+)?$/.test(file.archiveName)) {
        throw new Error('Unsafe, incomplete, or duplicate archive name');
      }
      names.add(file.archiveName);
      const owned = relative(root, await realpath(file.path));
      if (!owned || owned.startsWith(`..${sep}`) || owned === '..' || isAbsolute(owned)) throw new Error('File is outside this job directory');
      const checked = await verifyFile(file.path, file.originalName);
      if (checked.sha256 !== file.sha256 || checked.bytes !== file.bytes) throw new Error('Component hash/size changed before packaging');
      files.push(file);
    }
  }
  if (!files.length) throw new Error('No files to archive');
  if (files.length > MAX_PHYSICAL_FILES) throw new Error('Archive exceeds ten physical files');
  const temp = join(root, `archive-${randomUUID()}.tmp`);
  const path = join(root, `${matter}-${randomUUID()}.zip`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  try {
    let compressedBytes = 0;
    const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > maxZipBytes) callback(new ZipBudgetError('Attachment budget exceeded'));
      else callback(null, chunk);
    } });
    const written = pipeline(archive, guard, createWriteStream(temp, { flags: 'wx' }));
    archive.on('warning', error => archive.destroy(error));
    for (const file of files) archive.file(file.path!, { name: file.archiveName });
    await Promise.all([archive.finalize(), written]);
    await readBack(temp, files);
    const checked = await hashFile(temp);
    if (checked.bytes > maxZipBytes) throw new ZipBudgetError('Attachment budget exceeded');
    await rename(temp, path);
    return { path, ...checked, names: files.map(file => file.archiveName), recordIds: records.map(record => record.recordId) };
  } catch (error) {
    archive.abort();
    await rm(temp, { force: true });
    throw error;
  }
}

export async function packageRecords(input: {
  jobDir: string;
  matter: string;
  category: Category;
  snapshotMatterId: string;
  selectionMatterId: string;
  records: RetrievedRecord[];
  maxFiles?: number;
  maxZipBytes?: number;
}) {
  assertMatterIdentity(input.matter, input.snapshotMatterId);
  assertMatterIdentity(input.matter, input.selectionMatterId);
  const maxFiles = input.maxFiles ?? MAX_PHYSICAL_FILES;
  const maxZipBytes = input.maxZipBytes ?? MAX_ZIP_BYTES;
  if (input.records.length > MAX_PHYSICAL_FILES) throw new Error('Selection exceeds ten source records');
  const omissions: { recordId: string; reason: string }[] = [];
  const admitted: RetrievedRecord[] = [];
  let fileCount = 0;
  let kept: Awaited<ReturnType<typeof buildZip>> | null = null;
  for (const record of [...input.records].sort((a, b) => a.order - b.order)) {
    if (record.status !== 'complete') {
      omissions.push({ recordId: record.recordId, reason: record.failureReason ?? 'Record incomplete; entire record excluded.' });
      continue;
    }
    if (fileCount + record.components.length > maxFiles) {
      omissions.push({ recordId: record.recordId, reason: 'Whole record omitted because its files would exceed the ten-physical-file limit.' });
      continue;
    }
    try {
      const next = await buildZip(input.jobDir, input.matter, [...admitted, record], maxZipBytes);
      if (kept) await rm(kept.path, { force: true });
      kept = next;
      admitted.push(record);
      fileCount += record.components.length;
    } catch (error) {
      const budget = error instanceof ZipBudgetError || (error instanceof Error && error.message.includes('Attachment budget exceeded'));
      if (!budget) throw error;
      omissions.push({ recordId: record.recordId, reason: 'Whole record omitted because its ZIP would exceed the attachment budget.' });
    }
  }
  return {
    category: input.category,
    zipPath: kept?.path ?? null,
    zipBytes: kept?.bytes ?? null,
    zipSha256: kept?.sha256 ?? null,
    names: kept?.names ?? [],
    includedRecordIds: kept?.recordIds ?? [],
    fileCount,
    omissions,
  };
}
