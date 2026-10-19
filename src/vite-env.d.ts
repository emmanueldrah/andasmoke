/// <reference types="vite/client" />

interface ImportMetaEnv {
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

/**
 * The only capability the sandboxed renderer gets from the Electron main
 * process. Data access goes over fetch('/api/...') on the local server, so no
 * database or Node APIs are exposed here.
 */
interface Window {
  andaPos?: {
    print: () => Promise<boolean>;
    onUpdateAvailable: (callback: (info: { version?: string }) => void) => () => void;
    onUpdateDownloaded: (callback: (info: { version?: string }) => void) => () => void;
    restartAndInstallUpdate: () => Promise<void>;
    checkForUpdates: () => Promise<{ supported: boolean; available: boolean; version: string | null }>;
  };
}
