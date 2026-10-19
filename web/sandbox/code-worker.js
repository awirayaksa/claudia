// Python worker for the code interpreter (sandbox origin): Pyodide from
// /vendor/pyodide, extra packages (numpy, pandas, ...) from the Pyodide CDN
// when the code imports them. Each run gets a fresh namespace. Files the run
// writes under the working folder (HOME) go back with its result, so the app
// can hand them to the user: Pyodide's file system lives only in this worker.
/* global importScripts, loadPyodide */
'use strict';

// Keep in step with web/package.json (a test checks it)
const PYODIDE_VERSION = '0.28.3';

importScripts('/vendor/pyodide/pyodide.js');

let ready = null;

function init() {
  ready ??= loadPyodide({
    indexURL: '/vendor/pyodide/',
    packageBaseUrl: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
  });
  return ready;
}

const MAX_OUTPUT = 100000;

const HOME = '/home/pyodide';
// Keep in step with MAX_UPLOAD_BYTES (web/shared/files.ts): the app uploads each file
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** path → "mtime:size" for every file under HOME. */
function snapshot(FS) {
  const out = new Map();
  const walk = (dir) => {
    let names;
    try {
      names = FS.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.' || name === '..' || name === '__pycache__') continue;
      const p = `${dir}/${name}`;
      let st;
      try {
        st = FS.stat(p);
      } catch {
        continue;
      }
      if (FS.isDir(st.mode)) walk(p);
      else if (FS.isFile(st.mode)) out.set(p, `${+st.mtime}:${st.size}`);
    }
  };
  walk(HOME);
  return out;
}

/** Files the run created or changed: { files: [{ path, name, data }], skipped: [{ path, reason }] }. */
function collectFiles(FS, before) {
  const files = [];
  const skipped = [];
  let total = 0;
  for (const [p, sig] of snapshot(FS)) {
    if (before.get(p) === sig) continue;
    const rel = p.slice(HOME.length + 1);
    const size = Number(sig.split(':')[1]);
    if (files.length >= MAX_FILES) skipped.push({ path: rel, reason: `only ${MAX_FILES} files are kept per run` });
    else if (size > MAX_FILE_BYTES) skipped.push({ path: rel, reason: `larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB` });
    else if (total + size > MAX_TOTAL_BYTES) skipped.push({ path: rel, reason: `over ${MAX_TOTAL_BYTES / (1024 * 1024)} MB in all` });
    else {
      // A copy: the worker's own memory can't be transferred
      files.push({ path: rel, name: rel.split('/').pop(), data: FS.readFile(p).slice() });
      total += size;
    }
  }
  return { files, skipped };
}

self.onmessage = async (e) => {
  const { id, code } = e.data || {};
  let stdout = '';
  let stderr = '';
  const append = (which) => (line) => {
    if (which === 'out') stdout = (stdout + line + '\n').slice(0, MAX_OUTPUT);
    else stderr = (stderr + line + '\n').slice(0, MAX_OUTPUT);
  };
  try {
    const py = await init();
    py.setStdout({ batched: append('out') });
    py.setStderr({ batched: append('err') });
    await py.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: append('err') });
    const globals = py.globals.get('dict')();
    const before = snapshot(py.FS);
    let value;
    try {
      let outcome;
      try {
        value = await py.runPythonAsync(code, { globals });
        outcome = { result: value === undefined || value === null ? null : String(value.toString ? value.toString() : value).slice(0, MAX_OUTPUT) };
      } catch (err) {
        outcome = { error: String((err && err.message) || err).slice(0, MAX_OUTPUT) };
      }
      // Files written before an error reach the user too
      const { files, skipped } = collectFiles(py.FS, before);
      self.postMessage({ id, stdout, stderr, ...outcome, files, skipped }, files.map((f) => f.data.buffer));
    } finally {
      if (value && typeof value.destroy === 'function') value.destroy();
      globals.destroy();
    }
  } catch (err) {
    self.postMessage({ id, stdout, stderr, error: String((err && err.message) || err).slice(0, MAX_OUTPUT) });
  }
};
