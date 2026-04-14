/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WRITE_API_URL?: string;
  readonly VITE_BATCH_WRITE_URL?: string;
  readonly VITE_ELECTRIC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
