import React, { useEffect, useState } from 'react';
import { Check, Download, ExternalLink, Info, RefreshCw, ShieldCheck } from 'lucide-react';
import appMetadata from '../../../../package.json';
import { BrandMark } from '../../common/BrandMark';

type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'unsupported' | 'error';

export function AdminAboutScreen(): React.ReactElement {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [updateVersion, setUpdateVersion] = useState('');
  const bridge = window.andaPos;

  useEffect(() => {
    if (!bridge) return;
    const offAvailable = bridge.onUpdateAvailable(info => {
      setUpdateVersion(info?.version || '');
      setStatus(current => current === 'ready' ? current : 'downloading');
    });
    const offDownloaded = bridge.onUpdateDownloaded(info => {
      setUpdateVersion(info?.version || '');
      setStatus('ready');
    });
    return () => {
      offAvailable();
      offDownloaded();
    };
  }, [bridge]);

  const checkForUpdates = async () => {
    if (!bridge) {
      setStatus('unsupported');
      return;
    }
    setStatus('checking');
    try {
      const result = await bridge.checkForUpdates();
      if (!result.supported) {
        setStatus('unsupported');
      } else if (result.available) {
        setUpdateVersion(result.version || '');
        setStatus('downloading');
      } else {
        setUpdateVersion('');
        setStatus('current');
      }
    } catch {
      setStatus('error');
    }
  };

  const updateMessage: Record<UpdateStatus, string> = {
    idle: 'Check for the latest version of Anda C Smoke Hub POS.',
    checking: 'Checking the update service…',
    downloading: `Version ${updateVersion || 'new'} is available and downloading in the background.`,
    ready: `Version ${updateVersion || 'new'} is downloaded and ready to install.`,
    current: 'You are using the latest available version.',
    unsupported: 'Update checks are available in the installed desktop app.',
    error: 'The update check could not be completed. Check your connection and try again.',
  };

  return (
    <div className="max-w-5xl space-y-6">
      <section className="flex flex-col gap-5 border-b border-[var(--border-color)] pb-6 sm:flex-row sm:items-center">
        <BrandMark name={appMetadata.author} className="h-16 w-16 shrink-0 rounded-xl text-base" />
        <div className="min-w-0">
          <p className="eyebrow">Point of sale</p>
          <h2 className="brand-display text-2xl font-semibold text-[var(--text-primary)]">Anda C Smoke Hub POS</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--text-muted)]">{appMetadata.description}</p>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="lux-card space-y-4 p-5">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-[var(--accent)]" />
            <h3 className="text-sm font-bold text-[var(--text-primary)]">Application</h3>
          </div>
          <dl className="divide-y divide-[var(--border-color)]">
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-sm text-[var(--text-muted)]">Version</dt>
              <dd className="font-mono text-sm font-semibold text-[var(--text-primary)]">{appMetadata.version}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-sm text-[var(--text-muted)]">Platform</dt>
              <dd className="text-sm font-semibold text-[var(--text-primary)]">Windows desktop &amp; web</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <dt className="shrink-0 text-sm text-[var(--text-muted)]">Purpose</dt>
              <dd className="max-w-xs text-right text-sm text-[var(--text-primary)]">Till, inventory, team and sales reporting</dd>
            </div>
          </dl>
        </div>

        <div className="lux-card space-y-4 p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
            <h3 className="text-sm font-bold text-[var(--text-primary)]">Developer</h3>
          </div>
          <div>
            <p className="text-base font-bold text-[var(--text-primary)]">{appMetadata.author}</p>
            <p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">Developed for Anda C Smoke Hub to support day-to-day store operations.</p>
          </div>
          <a
            href="https://andasmoke.vercel.app"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--accent)] hover:underline"
          >
            Anda C Smoke Hub
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </section>

      <section className="lux-card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
            {status === 'ready' ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}
          </span>
          <div>
            <h3 className="text-sm font-bold text-[var(--text-primary)]">Software updates</h3>
            <p aria-live="polite" className="mt-1 text-sm leading-5 text-[var(--text-muted)]">{updateMessage[status]}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          {status === 'ready' && (
            <button
              type="button"
              onClick={() => void bridge?.restartAndInstallUpdate()}
              className="lux-btn lux-btn--primary lux-btn--sm"
            >
              <RefreshCw className="h-4 w-4" />
              Restart &amp; install
            </button>
          )}
          <button
            type="button"
            onClick={() => void checkForUpdates()}
            disabled={status === 'checking' || status === 'downloading' || status === 'ready'}
            className="lux-btn lux-btn--outline lux-btn--sm"
          >
            <RefreshCw className={`h-4 w-4 ${status === 'checking' ? 'animate-spin' : ''}`} />
            {status === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
      </section>
    </div>
  );
}
