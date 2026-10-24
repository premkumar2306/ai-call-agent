/// <reference types="vite/client" />

// Everything here is compiled into the public JS bundle — never put secrets
// (admin key, provider API keys) in a VITE_* variable.
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
