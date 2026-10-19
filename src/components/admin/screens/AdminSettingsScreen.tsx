import React from 'react';
import { MonitorCog, Moon, Sun } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { AdminPageHeader } from '../components/AdminPrimitives';
import { AdminHardwareSettingsScreen } from './AdminHardwareSettingsScreen';

export function AdminSettingsScreen(): React.ReactElement {
  const { theme, setTheme } = useTheme();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <AdminPageHeader description="Set the display style and tune the equipment used at this till." />

      <section className="lux-card p-5 md:p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
            <MonitorCog className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-bold text-[var(--text-primary)]">Appearance</h2>
            <p className="mt-1 text-sm leading-5 text-[var(--text-muted)]">Choose a display style for this device.</p>
          </div>
        </div>
        <div className="mt-5 inline-flex max-w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-soft)] p-1" role="group" aria-label="Appearance theme">
          <button
            type="button"
            aria-pressed={theme === 'light'}
            onClick={() => setTheme('light')}
            className={`flex min-w-28 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors ${theme === 'light' ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-[var(--shadow-soft)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
          >
            <Sun className="h-4 w-4" aria-hidden="true" />
            Light
          </button>
          <button
            type="button"
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme('dark')}
            className={`flex min-w-28 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors ${theme === 'dark' ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-[var(--shadow-soft)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
          >
            <Moon className="h-4 w-4" aria-hidden="true" />
            Dark
          </button>
        </div>
      </section>

      <AdminHardwareSettingsScreen />
    </div>
  );
}
