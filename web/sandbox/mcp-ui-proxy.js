/*
 * MCP-UI proxy (the `proxy` of @mcp-ui/client's UIResourceRenderer).
 *
 * Runs on the sandbox origin, never the app's: the app embeds this page, and
 * this page renders the tool's UI in an inner frame.
 *
 * - ?contentType=rawhtml: the app posts { type: 'ui-html-content', payload: { html } }
 *   after we announce 'ui-proxy-iframe-ready'; the HTML goes into a srcdoc
 *   frame WITHOUT allow-same-origin, so it gets an opaque origin and can't
 *   touch this origin's storage either.
 * - ?url=…: an external http(s) page in an inner frame.
 *
 * Messages are relayed both ways: from the inner frame only to our parent
 * (the app origin), and from the parent only into the inner frame.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var parentWindow = window.parent;
  if (!parentWindow || parentWindow === window) return;

  // The app's origin: the embedding page (frame-ancestors already limits who that can be)
  var appOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '*';

  var inner = document.createElement('iframe');
  inner.setAttribute('title', 'Tool interface');

  function relayFromInner(event) {
    if (event.source !== inner.contentWindow) return;
    parentWindow.postMessage(event.data, appOrigin);
  }

  function relayFromParent(event) {
    if (event.source !== parentWindow) return;
    if (appOrigin !== '*' && event.origin !== appOrigin) return;
    var data = event.data;
    if (data && data.type === 'ui-html-content') return; // handled below, not forwarded
    if (inner.contentWindow) inner.contentWindow.postMessage(data, '*');
  }

  window.addEventListener('message', relayFromInner);
  window.addEventListener('message', relayFromParent);

  if (params.get('contentType') === 'rawhtml') {
    // Scripts and forms only: no same-origin, no top navigation, no popups escaping the sandbox
    inner.setAttribute('sandbox', 'allow-scripts allow-forms');
    window.addEventListener('message', function onContent(event) {
      if (event.source !== parentWindow) return;
      if (appOrigin !== '*' && event.origin !== appOrigin) return;
      var data = event.data;
      if (!data || data.type !== 'ui-html-content' || !data.payload || typeof data.payload.html !== 'string') return;
      window.removeEventListener('message', onContent);
      inner.srcdoc = data.payload.html;
      document.body.appendChild(inner);
    });
  } else {
    var target = params.get('url');
    var url;
    try {
      url = target ? new URL(target) : null;
    } catch (e) {
      url = null;
    }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      document.body.textContent = 'This tool interface has no valid address.';
      return;
    }
    // A page from elsewhere keeps its own origin; it still can't reach the app's
    inner.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
    inner.src = url.toString();
    document.body.appendChild(inner);
  }

  parentWindow.postMessage({ type: 'ui-proxy-iframe-ready' }, appOrigin);
})();
