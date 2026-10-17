// "react/jsx-runtime" for plugins: the app's own runtime.
const runtime = window.__claudiaPluginHost.jsxRuntime;
export const { jsx, jsxs, Fragment } = runtime;
export default runtime;
