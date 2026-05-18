/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_AVERY_SECRET?: string;
  readonly VITE_ADMIN_KEY?: string;
  readonly VITE_DEEPGRAM_API_KEY?: string;
  readonly VITE_CARTESIA_API_KEY?: string;
  readonly VITE_CARTESIA_VOICE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
