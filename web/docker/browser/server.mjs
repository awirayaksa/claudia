// The browser service for Claudia's Web browser built-in (compose.browser.yml).
//
// A Playwright browser server on ws://0.0.0.0:3000/<WS_PATH>. The app
// connects to it and gives every chat its own context; every context goes
// out through the app's egress proxy (EGRESS_PROXY), which checks each
// connection. This container has no other way out: it sits on an internal
// network only.
import { chromium } from 'playwright-core';

const wsPath = process.env.WS_PATH ?? '';
const proxy = process.env.EGRESS_PROXY ?? '';
if (!/^[A-Za-z0-9_-]{24,}$/.test(wsPath)) {
  console.error('WS_PATH must be a random string of at least 24 letters, digits, - or _ (it is the only thing guarding the browser).');
  process.exit(1);
}
if (!/^https?:\/\//.test(proxy)) {
  console.error('EGRESS_PROXY must be the app\'s egress proxy, e.g. http://app:3128.');
  process.exit(1);
}

const server = await chromium.launchServer({
  host: '0.0.0.0',
  port: Number(process.env.PORT ?? 3000),
  wsPath: `/${wsPath}`,
  headless: true,
  // Contexts set their own proxy credentials; this one covers anything else
  proxy: { server: proxy },
  args: [
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--dns-prefetch-disable',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-sync',
    '--disable-extensions',
    '--no-first-run',
    '--disable-dev-shm-usage',
    '--metrics-recording-only',
  ],
});
console.log(`Browser server ready on port ${process.env.PORT ?? 3000}`);

const stop = async () => {
  await server.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
