/**
 * Minimal ZIP writer and reader.
 *
 * A manual export has to be a single file the owner can copy onto a USB stick,
 * and it has to hold the SQLite snapshot together with the product photos that
 * snapshot refers to. Node ships zlib but no archive format, and adding a
 * dependency for one file type is not worth it in an app that must run with no
 * internet, so this implements the small part of the ZIP spec that is needed:
 * store and deflate, no encryption, no multi-disk archives.
 *
 * Paths use forward slashes and are written exactly as given, so the archive
 * keeps the same layout on disk when it is unpacked.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** Below this size, deflate cannot win and is not attempted. */
const MIN_DEFLATE_BYTES = 64;

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = {
  /** Path inside the archive, using forward slashes. */
  path: string;
  data: Buffer;
  /** Fixed timestamp so the same input always produces the same archive. */
  modified: Date;
};

function dosDateTime(date: Date): { time: number; date: number } {
  // The DOS format starts at 1980 and cannot store anything earlier.
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Builds a ZIP archive in memory.
 *
 * Entries are deflated when that actually helps and stored when it does not, so
 * already-compressed photos are not inflated and recompressed for nothing.
 */
export function createZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const raw = entry.data;
    const crc = crc32(raw);

    // Skip deflate for tiny payloads: it can only add overhead, and an empty
    // "deflated" buffer would otherwise be written with the deflate flag set.
    const deflated = raw.length > MIN_DEFLATE_BYTES ? deflateRawSync(raw, { level: 6 }) : Buffer.alloc(0);
    const useDeflate = deflated.length > 0 && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const { time, date } = dosDateTime(entry.modified);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localChunks.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    centralChunks.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralDirectory, end]);
}

export type ReadZipEntry = { path: string; data: Buffer };

/** Thrown when a file is not a readable ZIP archive. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/**
 * Reads every entry out of a ZIP archive held in memory.
 *
 * Walks the central directory rather than scanning local headers, so an entry
 * whose data is damaged is still reported instead of silently skipped.
 */
export function readZip(archive: Buffer): ReadZipEntry[] {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  // The end record sits within the last 64KB (its own comment can be up to 64KB).
  const searchFrom = Math.max(0, archive.length - 65_557);
  for (let i = archive.length - 22; i >= searchFrom; i--) {
    if (archive.readUInt32LE(i) === eocdSignature) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('That file is not a ZIP archive.');

  const entryCount = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries: ReadZipEntry[] = [];

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new ZipError('That ZIP archive has a damaged directory.');
    }
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const path = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    cursor += 46 + nameLength + extraLength + commentLength;

    // Directory marker: no payload of its own.
    if (path.endsWith('/')) continue;

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ZipError(`Entry "${path}" has a damaged header.`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    try {
      data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    } catch {
      throw new ZipError(`Entry "${path}" could not be decompressed.`);
    }

    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) {
      throw new ZipError(`Entry "${path}" is damaged.`);
    }
    entries.push({ path, data });
  }

  return entries;
}