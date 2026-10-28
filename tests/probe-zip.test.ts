import test from 'node:test';
import assert from 'node:assert/strict';
import { probeZip } from '../src/probe.js';
import yauzl from 'yauzl';

test('generated probe ZIP independently opens as exactly one small nonce text file', async () => {
  const zip = await probeZip('abcdef0123456789abcdef0123456789');
  assert.ok(zip.length < 10_000);
  const files = await new Promise<{ name: string; text: string }[]>((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (error, reader) => {
      if (error || !reader) return reject(error);
      const files: { name: string; text: string }[] = [];
      reader.on('error', reject); reader.on('end', () => resolve(files));
      reader.on('entry', entry => reader.openReadStream(entry, (e, stream) => {
        if (e || !stream) return reject(e);
        const parts: Buffer[] = [];
        stream.on('data', (b: Buffer) => parts.push(b)); stream.on('error', reject);
        stream.on('end', () => { files.push({ name: entry.fileName, text: Buffer.concat(parts).toString() }); reader.readEntry(); });
      }));
      reader.readEntry();
    });
  });
  assert.deepEqual(files.map(f => f.name), ['probe.txt']);
  assert.match(files[0]!.text, /Nonce: abcdef0123456789abcdef0123456789/);
  assert.match(files[0]!.text, /no matter documents/);
});
