import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { AdminHardwareSettingsScreen } from './AdminHardwareSettingsScreen';

export function AdminSettingsScreen(): React.ReactElement {
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-7">
      <section className="max-w-3xl space-y-4">
        <div>
          <h2 className="text-lg font-bold text-[var(--text-primary)]">Appearance</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Choose how the till looks on this device.</p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Appearance theme">
          <button
            type="button"
            aria-pressed={theme === 'light'}
            onClick={() => setTheme('light')}
            className={`lux-btn lux-btn--sm ${theme === 'light' ? 'lux-btn--primary' : 'lux-btn--outline'}`}
          >
            <Sun className="h-4 w-4" />
            Light
          </button>
          <button
            type="button"
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme('dark')}
            className={`lux-btn lux-btn--sm ${theme === 'dark' ? 'lux-btn--primary' : 'lux-btn--outline'}`}
          >
            <Moon className="h-4 w-4" />
            Dark
          </button>
        </div>
      </section>

      <div className="border-t border-[var(--border-color)] pt-6">
        <AdminHardwareSettingsScreen />
      </div>
    </div>
  );
}
