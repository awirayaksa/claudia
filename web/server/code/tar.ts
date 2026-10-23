/**
 * Just enough tar for the Docker archive API: write a ustar archive of
 * files and folders (owned by one uid/gid), and read the regular files out
 * of one (ustar, PAX and GNU long names). Links and devices are skipped,
 * never followed.
 */

export interface TarEntry {
  /** Relative, with forward slashes; a trailing slash for a folder. */
  path: string;
  data?: Buffer;
  mode?: number;
}

const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, type: '0' | '5', mode: number, uid: number, gid: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  let prefix = '';
  let base = name;
  // ustar splits long names at a slash: prefix (155) + name (100)
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 2);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100 || Buffer.byteLength(name.slice(0, cut)) > 155) {
      throw new Error(`Path too long for the archive: ${name}`);
    }
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, 'utf-8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(uid, 8), 108, 8, 'ascii');
  h.write(octal(gid, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.fill(' ', 148, 156);
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf-8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

/** A tar archive of `entries`, every one owned by uid:gid. */
export function packTar(entries: TarEntry[], owner: { uid: number; gid: number } = { uid: 0, gid: 0 }): Buffer {
  const parts: Buffer[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const e of entries) {
    if (e.path.endsWith('/')) {
      parts.push(header(e.path, 0, '5', e.mode ?? 0o755, owner.uid, owner.gid, mtime));
      continue;
    }
    const data = e.data ?? Buffer.alloc(0);
    parts.push(header(e.path, data.byteLength, '0', e.mode ?? 0o644, owner.uid, owner.gid, mtime));
    parts.push(data);
    const pad = (BLOCK - (data.byteLength % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

const cstring = (b: Buffer) => {
  const end = b.indexOf(0);
  return b.subarray(0, end < 0 ? b.length : end).toString('utf-8');
};

/** PAX records: "<len> key=value\n". */
function paxPath(data: Buffer): string | null {
  let i = 0;
  const text = data.toString('utf-8');
  while (i < text.length) {
    const space = text.indexOf(' ', i);
    if (space < 0) break;
    const len = Number(text.slice(i, space));
    if (!len) break;
    const record = text.slice(space + 1, i + len - 1);
    if (record.startsWith('path=')) return record.slice(5);
    i += len;
  }
  return null;
}

/** The regular files in a tar archive (folders, links and devices left out). */
export function unpackTar(tar: Buffer): Array<{ path: string; data: Buffer }> {
  const out: Array<{ path: string; data: Buffer }> = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + BLOCK <= tar.length) {
    const h = tar.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(cstring(h.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = cstring(h.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/${cstring(h.subarray(0, 100))}` : cstring(h.subarray(0, 100)));
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    longName = null;
    if (type === 'x') {
      longName = paxPath(body);
      continue;
    }
    if (type === 'L') {
      longName = cstring(body);
      continue;
    }
    if (type === 'g') continue;
    if (type === '0' || type === '7') out.push({ path: name, data: Buffer.from(body) });
  }
  return out;
}
