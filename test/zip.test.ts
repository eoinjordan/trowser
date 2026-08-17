import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';

import { createZip, crc32, dosDateTime } from '../scripts/zip.mjs';

/**
 * Minimal central-directory reader used to prove the archive we emit is
 * actually parseable, rather than merely being bytes we wrote confidently.
 */
function readZip(archive: Buffer): Array<{ name: string; data: Buffer; method: number }> {
  const endSignature = 0x06054b50;
  let endOffset = archive.length - 22;

  while (endOffset >= 0 && archive.readUInt32LE(endOffset) !== endSignature) endOffset -= 1;
  assert.ok(endOffset >= 0, 'end of central directory record not found');

  const count = archive.readUInt16LE(endOffset + 10);
  let pointer = archive.readUInt32LE(endOffset + 16);
  const entries: Array<{ name: string; data: Buffer; method: number }> = [];

  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(pointer), 0x02014b50, 'bad central directory signature');

    const method = archive.readUInt16LE(pointer + 10);
    const storedCrc = archive.readUInt32LE(pointer + 16);
    const compressedSize = archive.readUInt32LE(pointer + 20);
    const uncompressedSize = archive.readUInt32LE(pointer + 24);
    const nameLength = archive.readUInt16LE(pointer + 28);
    const extraLength = archive.readUInt16LE(pointer + 30);
    const commentLength = archive.readUInt16LE(pointer + 32);
    const localOffset = archive.readUInt32LE(pointer + 42);
    const name = archive.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');

    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50, 'bad local header signature');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);

    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);

    assert.equal(data.length, uncompressedSize, 'size mismatch for ' + name);
    assert.equal(crc32(data), storedCrc, 'crc mismatch for ' + name);

    entries.push({ name, data, method });
    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe('crc32', () => {
  it('matches the standard check vector', () => {
    // The canonical CRC-32 of "123456789" is 0xCBF43926.
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  it('returns 0 for empty input', () => {
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });

  it('always returns an unsigned 32-bit value', () => {
    for (const input of ['a', 'hello world', '\xff\xff\xff\xff', 'x'.repeat(10000)]) {
      const value = crc32(Buffer.from(input, 'binary'));
      assert.ok(value >= 0 && value <= 0xffffffff, 'out of range: ' + value);
      assert.ok(Number.isInteger(value));
    }
  });
});

describe('dosDateTime', () => {
  it('encodes a known timestamp', () => {
    const { time, date } = dosDateTime(new Date(2024, 4, 17, 13, 45, 30));
    assert.equal(date, ((2024 - 1980) << 9) | (5 << 5) | 17);
    assert.equal(time, (13 << 11) | (45 << 5) | 15);
  });

  it('clamps dates before the 1980 DOS epoch', () => {
    const { date } = dosDateTime(new Date(1970, 0, 1));
    assert.ok(date >= 0 && date <= 0xffff);
  });

  it('always produces values that fit in 16 bits', () => {
    for (const year of [1980, 1999, 2024, 2107]) {
      const { time, date } = dosDateTime(new Date(year, 11, 31, 23, 59, 59));
      assert.ok(time >= 0 && time <= 0xffff);
      assert.ok(date >= 0 && date <= 0xffff);
    }
  });
});

describe('createZip', () => {
  it('round-trips a single file', () => {
    const archive = createZip([{ name: 'hello.txt', data: Buffer.from('hello world') }]);
    const entries = readZip(archive);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'hello.txt');
    assert.equal(entries[0].data.toString(), 'hello world');
  });

  it('round-trips many files including nested paths', () => {
    const input = [
      { name: 'manifest.json', data: Buffer.from('{"manifest_version":3}') },
      { name: 'chunks/lib.js', data: Buffer.from('console.log(1)'.repeat(500)) },
      { name: 'icons/icon-16.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) }
    ];

    const entries = readZip(createZip(input));

    assert.deepEqual(entries.map((entry) => entry.name).sort(), input.map((entry) => entry.name).sort());
    for (const original of input) {
      const found = entries.find((entry) => entry.name === original.name);
      assert.ok(found, 'missing ' + original.name);
      assert.deepEqual(found.data, original.data);
    }
  });

  it('compresses compressible data and stores incompressible data', () => {
    const compressible = createZip([{ name: 'a', data: Buffer.alloc(5000, 0x41) }]);
    assert.equal(readZip(compressible)[0].method, 8);
    assert.ok(compressible.length < 5000, 'compressible payload should shrink');

    // Four random bytes cannot be deflated smaller, so it must be stored.
    const incompressible = createZip([{ name: 'b', data: Buffer.from([1, 2, 3, 4]) }]);
    assert.equal(readZip(incompressible)[0].method, 0);
  });

  it('normalises backslashes to forward slashes', () => {
    const entries = readZip(createZip([{ name: 'chunks\\lib.js', data: Buffer.from('x') }]));
    assert.equal(entries[0].name, 'chunks/lib.js');
  });

  it('handles an empty file and an empty archive', () => {
    assert.deepEqual(readZip(createZip([{ name: 'empty', data: Buffer.alloc(0) }]))[0].data, Buffer.alloc(0));
    assert.deepEqual(readZip(createZip([])), []);
  });

  it('preserves UTF-8 in file names and contents', () => {
    const entries = readZip(createZip([{ name: 'näme-日本.txt', data: Buffer.from('héllo 世界', 'utf8') }]));
    assert.equal(entries[0].name, 'näme-日本.txt');
    assert.equal(entries[0].data.toString('utf8'), 'héllo 世界');
  });

  it('is byte-for-byte reproducible with a fixed timestamp', () => {
    const files = [{ name: 'a.js', data: Buffer.from('const a = 1;') }];
    const stamp = new Date('1980-01-01T00:00:00Z');

    assert.deepEqual(createZip(files, stamp), createZip(files, stamp));
  });

  it('writes external attributes as an unsigned value', () => {
    // A signed shift here previously overflowed and threw on write.
    const archive = createZip([{ name: 'a', data: Buffer.from('x') }]);
    const endOffset = archive.length - 22;
    const centralOffset = archive.readUInt32LE(endOffset + 16);
    const attributes = archive.readUInt32LE(centralOffset + 38);

    assert.ok(attributes > 0 && attributes <= 0xffffffff);
  });
});
