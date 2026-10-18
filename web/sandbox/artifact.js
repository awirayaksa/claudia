// Artifact host page (sandbox origin). See artifact.html.
(() => {
  'use strict';
  const frame = document.getElementById('frame');
  const errorBox = document.getElementById('error');
  // URL origin (this document's security origin may be opaque)
  const here = location.origin;

  // No fetch/XHR/WebSocket, no forms, nothing loaded from other sites except images, media and fonts
  const CSP = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${here}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob: https:',
    'media-src data: blob: https:',
    'font-src data: https:',
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  const esc = (s) => JSON.stringify(s).replace(/</g, '\\u003c');

  // Tells the app how tall the content is
  const SIZE_SCRIPT = `<script>new ResizeObserver(() => parent.postMessage({ type: 'claudia-artifact-size', height: document.documentElement.scrollHeight }, '*')).observe(document.documentElement);<\/script>`;

  function htmlDoc(code) {
    const hasHead = /<head[^>]*>/i.test(code);
    const hasHtml = /<html[^>]*>/i.test(code);
    if (hasHead) return code.replace(/<head[^>]*>/i, (m) => `${m}${META}`).replace(/<\/body>/i, `${SIZE_SCRIPT}</body>`);
    if (hasHtml) return code.replace(/<html[^>]*>/i, (m) => `${m}<head>${META}</head>`) + SIZE_SCRIPT;
    return `<!doctype html><html><head><meta charset="utf-8">${META}</head><body>${code}${SIZE_SCRIPT}</body></html>`;
  }

  function svgDoc(code) {
    return `<!doctype html><html><head><meta charset="utf-8">${META}<style>html,body{margin:0}body{display:flex;justify-content:center;align-items:flex-start;padding:8px}svg{max-width:100%;height:auto}</style></head><body>${code}${SIZE_SCRIPT}</body></html>`;
  }

  function reactDoc(code) {
    return `<!doctype html><html><head><meta charset="utf-8">${META}
<style>body{margin:0;font-family:system-ui,sans-serif}#claudia-error{margin:12px;padding:10px 12px;border-radius:6px;font-size:13px;color:#9b1c1c;background:#fdecec;white-space:pre-wrap}</style>
<script src="${here}/vendor/react.js"><\/script>
<script src="${here}/vendor/react-dom.js"><\/script>
<script src="${here}/vendor/babel.js"><\/script>
</head><body><div id="root"></div>
<script>
(function () {
  function fail(message) {
    var box = document.createElement('div');
    box.id = 'claudia-error';
    box.textContent = message;
    document.body.appendChild(box);
  }
  try {
    var compiled = Babel.transform(${esc(code)}, {
      filename: 'Artifact.tsx',
      presets: [['env', { modules: 'commonjs' }], 'react', ['typescript', { allExtensions: true, isTSX: true }]],
    }).code;
    var module = { exports: {} };
    var req = function (name) {
      if (name === 'react') return React;
      if (name === 'react-dom' || name === 'react-dom/client') return ReactDOM;
      throw new Error('Previews can only import react, not "' + name + '".');
    };
    new Function('module', 'exports', 'require', 'React', compiled)(module, module.exports, req, React);
    var exp = module.exports;
    var App = exp.default || Object.keys(exp).map(function (k) { return exp[k]; }).find(function (v) { return typeof v === 'function'; });
    if (!App) throw new Error('The code has no component to show (export a default component).');
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
  } catch (e) {
    fail(String(e && e.message || e));
  }
})();
<\/script>${SIZE_SCRIPT}</body></html>`;
  }

  window.addEventListener('message', (e) => {
    if (e.source === frame.contentWindow) {
      // Size reports from the content go up to the app
      if (e.data && e.data.type === 'claudia-artifact-size') {
        window.parent.postMessage({ type: 'claudia-artifact-size', height: Number(e.data.height) || 0 }, '*');
      }
      return;
    }
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.type !== 'claudia-artifact-render' || typeof m.code !== 'string') return;
    errorBox.style.display = 'none';
    const kind = m.kind;
    frame.srcdoc = kind === 'svg' ? svgDoc(m.code) : kind === 'react' ? reactDoc(m.code) : htmlDoc(m.code);
  });

  window.parent.postMessage({ type: 'claudia-artifact-ready' }, '*');
})();
