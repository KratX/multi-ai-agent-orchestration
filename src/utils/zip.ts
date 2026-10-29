/**
 * Pure TypeScript ZIP Archive Builder (Preserves Exact Nested Folder Structure)
 *
 * Why this exists:
 * Browser `<a download="src/server/db/schema/agents.ts">` links strip `/` slashes
 * for security and flatten files into the root folder.
 * Packaging files into a standard PKZIP archive (`STORE` method 0 with IEEE 802.3 CRC-32)
 * preserves the exact directory hierarchy (`src/server/db/schema/agents.ts`, `tests/security/...`)
 * so extracting the `.zip` in the repository root places every file in its exact folder!
 */

export interface ZipEntryInput {
  /** Relative path from repository root, e.g. "src/server/db/schema/agents.ts" */
  path: string;
  /** UTF-8 string contents of the file */
  content: string;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZipBlob(entries: ZipEntryInput[]): Blob {
  const encoder = new TextEncoder();
  const localFileHeaders: BlobPart[] = [];
  const centralDirectoryHeaders: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    // Normalize path without leading slash so unzip extracts relative to repo root
    const normalizedPath = entry.path.replace(/^\/+/, '');
    const nameBytes = encoder.encode(normalizedPath);
    const dataBytes = encoder.encode(entry.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // 1. Local file header (30 bytes + filename + data)
    const localHeader = new Uint8Array(30 + nameBytes.length + size);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true); // Local file header signature
    localView.setUint16(4, 20, true); // Version needed to extract (2.0)
    localView.setUint16(6, 0x0800, true); // General purpose bit flag (UTF-8 filename)
    localView.setUint16(8, 0, true); // Compression method (0 = STORE / uncompressed)
    localView.setUint16(10, 0, true); // Last mod file time
    localView.setUint16(12, 0x549c, true); // Last mod file date
    localView.setUint32(14, crc, true); // CRC-32
    localView.setUint32(18, size, true); // Compressed size
    localView.setUint32(22, size, true); // Uncompressed size
    localView.setUint16(26, nameBytes.length, true); // File name length
    localView.setUint16(28, 0, true); // Extra field length
    localHeader.set(nameBytes, 30);
    localHeader.set(dataBytes, 30 + nameBytes.length);
    localFileHeaders.push(localHeader);

    // 2. Central directory file header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true); // Central directory file header signature
    centralView.setUint16(4, 20, true); // Version made by
    centralView.setUint16(6, 20, true); // Version needed to extract
    centralView.setUint16(8, 0x0800, true); // General purpose bit flag (UTF-8)
    centralView.setUint16(10, 0, true); // Compression method (0 = STORE)
    centralView.setUint16(12, 0, true); // Last mod file time
    centralView.setUint16(14, 0x549c, true); // Last mod file date
    centralView.setUint32(16, crc, true); // CRC-32
    centralView.setUint32(20, size, true); // Compressed size
    centralView.setUint32(24, size, true); // Uncompressed size
    centralView.setUint16(28, nameBytes.length, true); // File name length
    centralView.setUint16(30, 0, true); // Extra field length
    centralView.setUint16(32, 0, true); // File comment length
    centralView.setUint16(34, 0, true); // Disk number start
    centralView.setUint16(36, 0, true); // Internal file attributes
    centralView.setUint32(38, 0, true); // External file attributes
    centralView.setUint32(42, offset, true); // Relative offset of local header
    centralHeader.set(nameBytes, 46);
    centralDirectoryHeaders.push(centralHeader);

    offset += localHeader.length;
  }

  let centralDirectorySize = 0;
  for (const ch of centralDirectoryHeaders) {
    centralDirectorySize += ch.length;
  }

  // 3. End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
  eocdView.setUint16(4, 0, true); // Number of this disk
  eocdView.setUint16(6, 0, true); // Disk where central directory starts
  eocdView.setUint16(8, entries.length, true); // Number of central directory records on this disk
  eocdView.setUint16(10, entries.length, true); // Total number of central directory records
  eocdView.setUint32(12, centralDirectorySize, true); // Size of central directory
  eocdView.setUint32(16, offset, true); // Offset of start of central directory
  eocdView.setUint16(20, 0, true); // Comment length

  const blobParts: BlobPart[] = [
    ...localFileHeaders,
    ...(centralDirectoryHeaders as unknown as BlobPart[]),
    eocd as unknown as BlobPart,
  ];

  return new Blob(blobParts, {
    type: 'application/zip',
  });
}
