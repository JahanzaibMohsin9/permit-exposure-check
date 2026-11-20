/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_REGISTRY_ADDRESS?: string;
  readonly VITE_DEMO_PERMIT_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
