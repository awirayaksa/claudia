// "unified" for plugins: the app's own unified (for remark/rehype plugins).
const host = window.__claudiaPluginHost;
export const unified = host.unified;
export default host.unified;
