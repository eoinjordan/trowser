/**
 * Minimal ZIP writer.
 *
 * The `zip` CLI is not present on every developer machine (notably Windows),
 * and pulling an archiver dependency into a security-sensitive extension for
 * one build step is a poor trade. This implements the subset of the ZIP spec
 * Chrome needs: deflate-compressed entries, no encryption, no zip64.
 */

import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** Converts a Date into the DOS time/date pair ZIP stores. */
export function dosDateTime(date) {
  // The DOS epoch starts in 1980; anything earlier is clamped to it.
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * Builds a ZIP archive.
 * @param {Array<{ name: string, data: Buffer, date?: Date }>} entries
 * @returns {Buffer}
 */
export function createZip(entries, now = new Date()) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    // ZIP always uses forward slashes, regardless of host platform.
    const name = Buffer.from(entry.name.split('\\').join('/'), 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });

    // Only use deflate when it actually helps; otherwise store the raw bytes.
    const useDeflate = compressed.length < entry.data.length;
    const payload = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;

    const { time, date } = dosDateTime(entry.date ?? now);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    // Unix mode 0644 in the high 16 bits. The shift must be coerced back to
    // unsigned; a bare `<< 16` overflows into a negative 32-bit value.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuffer, end]);
}
