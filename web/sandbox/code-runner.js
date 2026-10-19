// Code interpreter host page (sandbox origin). See code-runner.html.
(() => {
  'use strict';
  let worker = null;
  /** id → { source, origin, timer } */
  const pending = new Map();

  function reply(id, result) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    // Hand over the files' bytes rather than copying them
    const transfer = (result.files || []).map((f) => f.data && f.data.buffer).filter(Boolean);
    p.source.postMessage({ type: 'claudia-code-result', id, ...result }, p.origin, transfer);
  }

  function start() {
    worker = new Worker('/code-worker.js');
    worker.onmessage = (e) => {
      const { id, ...result } = e.data || {};
      reply(id, result);
    };
    worker.onerror = (e) => {
      // Everything waiting on this worker fails; the next run starts a new one
      for (const id of [...pending.keys()]) reply(id, { stdout: '', stderr: '', error: e.message || 'The Python worker crashed.' });
      worker = null;
    };
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.type !== 'claudia-code-run' || typeof m.id !== 'string' || typeof m.code !== 'string') return;
    if (!worker) start();
    const timeoutMs = Math.min(Math.max(Number(m.timeoutMs) || 60000, 1000), 600000);
    const timer = setTimeout(() => {
      // Stop the run: end the worker (and with it anything else it was doing)
      worker?.terminate();
      worker = null;
      for (const id of [...pending.keys()]) {
        reply(id, { stdout: '', stderr: '', error: `Stopped after ${Math.round(timeoutMs / 1000)} seconds.` });
      }
    }, timeoutMs);
    pending.set(m.id, { source: e.source, origin: e.origin, timer });
    worker.postMessage({ id: m.id, code: m.code });
  });

  // Nothing secret in the ready signal, so any parent may hear it (frame-ancestors limits who that is)
  window.parent.postMessage({ type: 'claudia-code-ready' }, '*');
})();
