import React, { useEffect, useState } from 'react';
import { Check, Download, ExternalLink, Globe, Info, Mail, Phone, RefreshCw, ShieldCheck } from 'lucide-react';
import appMetadata from '../../../../package.json';
import { BrandMark } from '../../common/BrandMark';
import { AdminPageHeader } from '../components/AdminPrimitives';

type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'unsupported' | 'error';

const UPDATE_MANIFEST_URL = '/updates/win/latest.yml';

/** Parses `version: 1.2.3` from the electron-updater latest.yml manifest. */
const parseManifestVersion = (text: string): string | null => {
  const match = text.match(/^version:\s*(.+)$/m);
  return match ? match[1].trim() : null;
};

export function AdminAboutScreen(): React.ReactElement {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [updateVersion, setUpdateVersion] = useState('');
  const [latestVersion, setLatestVersion] = useState(appMetadata.version);
  const bridge = window.andaPos;

  // On mount, find out what the latest released version is. Desktop asks the
  // auto-updater; web fetches the manifest directly so the number is never
  // stale between releases.
  useEffect(() => {
    let cancelled = false;
    if (bridge) {
      const offAvailable = bridge.onUpdateAvailable(info => {
        const v = info?.version || '';
        if (v) setLatestVersion(v);
        setUpdateVersion(v);
        setStatus(current => current === 'ready' ? current : 'downloading');
      });
      const offDownloaded = bridge.onUpdateDownloaded(info => {
        const v = info?.version || '';
        if (v) setLatestVersion(v);
        setUpdateVersion(v);
        setStatus('ready');
      });
      // Kick off a check so the latest version shows even before the user
      // clicks the button.
      void (async () => {
        setStatus('checking');
        try {
          const result = await bridge.checkForUpdates();
          if (cancelled) return;
          if (!result.supported) {
            setStatus('unsupported');
          } else if (result.available) {
            const v = result.version || '';
            if (v) setLatestVersion(v);
            setUpdateVersion(v);
            setStatus('downloading');
          } else {
            setStatus('current');
          }
        } catch {
          if (!cancelled) setStatus('error');
        }
      })();
      return () => { cancelled = true; offAvailable(); offDownloaded(); };
    }
    // Web path: read the manifest so the version number reflects the latest
    // release even when the user has not yet refreshed the desktop installer.
    void (async () => {
      setStatus('checking');
      try {
        const res = await fetch(UPDATE_MANIFEST_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error('manifest unavailable');
        const text = await res.text();
        const v = parseManifestVersion(text);
        if (cancelled) return;
        if (v) setLatestVersion(v);
        setStatus(v && v !== appMetadata.version ? 'downloading' : 'current');
      } catch {
        if (!cancelled) setStatus('unsupported');
      }
    })();
    return () => { cancelled = true; };
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
        const v = result.version || '';
        if (v) setLatestVersion(v);
        setUpdateVersion(v);
        setStatus('downloading');
      } else {
        setUpdateVersion('');
        setStatus('current');
      }
    } catch {
      setStatus('error');
    }
  };

  const isOutdated = latestVersion !== appMetadata.version;

  const updateMessage: Record<UpdateStatus, string> = {
    idle: 'Check for the latest version of SAD POS.',
    checking: 'Checking the update service…',
    downloading: `Version ${updateVersion || latestVersion} is available and downloading in the background.`,
    ready: `Version ${updateVersion || latestVersion} is downloaded and ready to install.`,
    current: 'You are using the latest available version.',
    unsupported: 'Update checks are available in the installed desktop app.',
    error: 'The update check could not be completed. Check your connection and try again.',
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <AdminPageHeader description="Application information, developer contact details, and software updates." />

      <section className="lux-card flex flex-col gap-4 p-5 sm:flex-row sm:items-center md:p-6">
        <BrandMark name="SAD POS" className="h-14 w-14 shrink-0 rounded-xl text-sm" />
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--text-subtle)]">Point of sale system</p>
          <h2 className="brand-display mt-1 text-xl font-semibold text-[var(--text-primary)]">SAD POS</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--text-muted)]">A modern point of sale built for retail businesses. Manage your till, inventory, staff, and sales reporting from one place, on desktop or web.</p>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="lux-card space-y-4 p-4 md:p-5">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-[var(--accent)]" />
            <h3 className="text-sm font-bold text-[var(--text-primary)]">Application</h3>
          </div>
          <dl className="divide-y divide-[var(--border-color)]">
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-sm text-[var(--text-muted)]">Version</dt>
              <dd className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">{latestVersion}</span>
                {isOutdated && (
                  <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--accent)]">Latest</span>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-sm text-[var(--text-muted)]">Installed</dt>
              <dd className="font-mono text-sm text-[var(--text-muted)]">{appMetadata.version}{isOutdated ? ' — update available' : ''}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-sm text-[var(--text-muted)]">Platform</dt>
              <dd className="text-sm font-semibold text-[var(--text-primary)]">Windows desktop &amp; web</dd>
            </div>
          </dl>
        </div>

        <div className="lux-card space-y-4 p-4 md:p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
            <h3 className="text-sm font-bold text-[var(--text-primary)]">Developer</h3>
          </div>
          <div>
            <p className="text-base font-bold text-[var(--text-primary)]">Success Above Dreams (SAD)</p>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Software and web developer building tools for small businesses.</p>
          </div>
          <dl className="space-y-3 border-t border-[var(--border-color)] pt-4 text-sm">
            <div className="flex items-center gap-2 text-[var(--text-muted)]">
              <Mail className="h-4 w-4 shrink-0 text-[var(--accent)]" />
              <a href="mailto:emmanueldrah10@gmail.com" className="break-all hover:text-[var(--accent)]">emmanueldrah10@gmail.com</a>
            </div>
            <div className="flex items-center gap-2 text-[var(--text-muted)]">
              <Phone className="h-4 w-4 shrink-0 text-[var(--accent)]" />
              <a href="tel:0543671806" className="hover:text-[var(--accent)]">0543671806</a>
            </div>
            <div className="flex items-center gap-2 text-[var(--text-muted)]">
              <Globe className="h-4 w-4 shrink-0 text-[var(--accent)]" />
              <a href="https://emmanueldrah.vercel.app" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 break-all hover:text-[var(--accent)]">
                emmanueldrah.vercel.app
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
            </div>
          </dl>
        </div>
      </section>

      <section className="lux-card flex flex-col gap-4 p-4 md:p-5 sm:flex-row sm:items-center sm:justify-between">
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
