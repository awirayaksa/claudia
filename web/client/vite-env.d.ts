/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin serving the sandbox pages (MCP-UI proxy, artifacts, previews). */
  readonly VITE_CLAUDIA_SANDBOX_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
