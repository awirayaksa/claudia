// Python worker for the code interpreter (sandbox origin): Pyodide from
// /vendor/pyodide, extra packages (numpy, pandas, ...) from the Pyodide CDN
// when the code imports them. Each run gets a fresh namespace.
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
    let value;
    try {
      value = await py.runPythonAsync(code, { globals });
      const result = value === undefined || value === null ? null : String(value.toString ? value.toString() : value).slice(0, MAX_OUTPUT);
      self.postMessage({ id, stdout, stderr, result });
    } finally {
      if (value && typeof value.destroy === 'function') value.destroy();
      globals.destroy();
    }
  } catch (err) {
    self.postMessage({ id, stdout, stderr, error: String((err && err.message) || err).slice(0, MAX_OUTPUT) });
  }
};
