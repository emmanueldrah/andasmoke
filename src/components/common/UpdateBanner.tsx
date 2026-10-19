import React, { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';

/**
 * Desktop-only nudge that the till has a newer version. It stays out of the way
 * (a small card in the corner) and appears the moment an update is published —
 * "available" while it downloads, "ready" once it can be applied. Applying it
 * restarts the till; the normal install-on-quit path still works if it is left
 * alone.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<{ version: string; ready: boolean } | null>(null);

  useEffect(() => {
    const bridge = window.andaPos;
    if (!bridge) return;

    const offAvailable = bridge.onUpdateAvailable?.(info => {
      setUpdate(prev => (prev?.ready ? prev : { version: info?.version || 'new', ready: false }));
    });
    const offReady = bridge.onUpdateDownloaded(info => {
      setUpdate(prev => ({ version: info?.version || prev?.version || 'new', ready: true }));
    });

    return () => {
      offAvailable?.();
      offReady();
    };
  }, []);

  if (!update) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[90] w-72 max-w-[calc(100vw-2rem)]">
      <div className="lux-card flex items-start gap-3 p-3.5 shadow-[0_18px_45px_-18px_rgba(0,0,0,0.45)]">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
          {update.ready
            ? <RefreshCw className="h-4 w-4" />
            : <Download className="h-4 w-4 animate-pulse" />}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-[var(--text-primary)]">
            {update.ready ? 'Update ready' : 'Update available'}
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-muted)]">
            {update.ready
              ? `Version ${update.version} is downloaded.`
              : `Version ${update.version} is downloading in the background.`}
          </p>
          {update.ready && (
            <button
              type="button"
              onClick={() => void window.andaPos?.restartAndInstallUpdate()}
              className="lux-btn lux-btn--primary lux-btn--sm mt-2.5 w-full"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Restart &amp; install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
