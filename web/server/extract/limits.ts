/**
 * Limits for parsing untrusted documents. The worker enforces the zip checks
 * before a zip-based format (docx, xlsx, pptx) is opened; the pool enforces
 * input size, time and heap.
 */

export const EXTRACT_LIMITS = {
  /** Largest file accepted for parsing. */
  maxInputBytes: 25 * 1024 * 1024,
  /** Per-job wall clock; the worker thread is killed when it runs over. */
  timeoutMs: 30_000,
  /** Worker heap (old generation), in MB. */
  maxHeapMb: 384,
  /** Zip formats: total declared uncompressed size, entries, and compression ratio. */
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxZipEntries: 5_000,
  maxCompressionRatio: 200,
  /** Text returned per document; longer text is cut off and marked truncated. */
  maxTextChars: 2_000_000,
} as const;

export class ExtractLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractLimitError';
  }
}

/**
 * Read a zip's central directory (without inflating anything) and refuse
 * archives that would expand too far: zip bombs, entry floods, ZIP64.
 */
export function inspectZip(
  buf: Buffer,
  limits: { maxUncompressedBytes: number; maxZipEntries: number; maxCompressionRatio: number } = EXTRACT_LIMITS
): { entries: number; uncompressed: number } {
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes
  const minEocd = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExtractLimitError('Not a valid zip-based document.');

  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ExtractLimitError('ZIP64 documents are not supported.');
  }
  if (total > limits.maxZipEntries) {
    throw new ExtractLimitError(`The document has too many parts (${total}).`);
  }
  if (cdOffset + cdSize > buf.length) throw new ExtractLimitError('The document is damaged (central directory).');

  let uncompressed = 0;
  let compressed = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new ExtractLimitError('The document is damaged (entry header).');
    }
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new ExtractLimitError('ZIP64 documents are not supported.');
    compressed += csize;
    uncompressed += usize;
    if (uncompressed > limits.maxUncompressedBytes) {
      throw new ExtractLimitError('The document expands to more than the allowed size.');
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (compressed > 0 && uncompressed / compressed > limits.maxCompressionRatio && uncompressed > 10 * 1024 * 1024) {
    throw new ExtractLimitError('The document is compressed suspiciously well (possible zip bomb).');
  }
  return { entries: total, uncompressed };
}
