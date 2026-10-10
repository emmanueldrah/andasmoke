import React, { useEffect, useState } from 'react';
import { useStore } from '../../context/StoreContext';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../context/ThemeContext';
import { api, ApiError } from '../../lib/api';
import {
  Lock,
  ArrowRight,
  Eye,
  EyeOff,
  Mail,
  Sun,
  Moon,
  ShieldCheck,
  UserPlus,
  Store,
} from 'lucide-react';
import { BrandMark } from '../common/BrandMark';

interface AdminLoginProps {
  onSuccess: () => void;
  mode?: 'admin' | 'pos';
}

type SetupState = 'checking' | 'needed' | 'done';

/**
 * First-run setup, then staff sign-in.
 *
 * A new till has no accounts, so it asks the owner to create the single super
 * admin once. After that the setup route refuses further calls and this screen
 * is just a PIN prompt.
 */
export const AdminLoginView: React.FC<AdminLoginProps> = ({ onSuccess, mode = 'admin' }) => {
  const { loginAdmin, storeSettings } = useStore();
  const { showToast } = useToast();
  const { theme, toggleTheme, isDark } = useTheme();

  const [setup, setSetup] = useState<SetupState>('checking');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.get<{ needsSetup: boolean }>('/auth?action=setup-status')
      .then((result) => { if (active) setSetup(result?.needsSetup ? 'needed' : 'done'); })
      .catch(() => { if (active) setSetup('done'); });
    return () => { active = false; };
  }, []);

  const handleSetupSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError('Enter the owner’s name.');
    if (!email.trim()) return setError('Enter an email address for this account.');
    if (pin.trim().length < 4) return setError('The PIN must be at least 4 characters.');
    if (pin !== confirmPin) return setError('The two PINs do not match.');

    setIsLoading(true);
    try {
      const result = await api.post<{ token: string; admin: { adminName: string } }>('/auth?action=setup', {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        pin: pin.trim(),
      });
      // Setup returns a usable session, so go straight in.
      localStorage.setItem('anda_auth_token', result.token);
      const signedIn = await loginAdmin(pin.trim(), email.trim().toLowerCase());
      if (signedIn) {
        showToast('Till set up. Welcome!');
        onSuccess();
      } else {
        setError('Account created. Please sign in.');
        setSetup('done');
      }
    } catch (caught: any) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the owner account.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!email.trim()) return setError('Enter your email address.');
    if (!pin.trim()) return setError('Enter your PIN.');

    setIsLoading(true);
    try {
      const success = await loginAdmin(pin.trim(), email.trim().toLowerCase());
      if (success) {
        showToast('Signed in');
        onSuccess();
      } else {
        setError('Incorrect email or PIN. Please try again.');
      }
    } catch {
      setError('Cannot reach the till service. Please restart the app.');
    } finally {
      setIsLoading(false);
    }
  };

  const isSetup = setup === 'needed';
  const submit = isSetup ? handleSetupSubmit : handleSignIn;
  const inputClass = 'tactile-control w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-main)] py-3 pr-4 text-sm text-[var(--text-primary)] placeholder-[var(--text-subtle)] transition focus:border-[var(--accent)] focus:bg-[var(--bg-card)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20';

  return (
    <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(197,150,81,0.18),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(71,123,104,0.14),transparent_38%),linear-gradient(135deg,rgba(17,13,12,0.8),rgba(24,17,15,0.55),rgba(9,9,9,0.82))] text-[var(--text-primary)] font-sans transition-colors duration-200">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-4 rounded-[32px] border border-white/10 bg-white/[0.02] backdrop-blur-[22px]" />
        <div className="absolute inset-8 rounded-[28px] border border-white/[0.08] bg-[rgba(255,255,255,0.015)] backdrop-blur-[28px]" />
        <div className="absolute inset-0 flex items-center justify-center opacity-[0.10]">
          <BrandMark
            name={storeSettings.storeName}
            className="h-[30rem] w-[30rem] rounded-[30%] border border-white/10 bg-white/[0.03] shadow-[0_0_50px_rgba(255,255,255,0.06)]"
          />
        </div>
      </div>

      <header className="relative z-10 mx-auto flex w-full max-w-7xl justify-end px-6 py-6">
        <button
          type="button"
          onClick={toggleTheme}
          className="flex items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-semibold text-[var(--text-muted)] shadow-[var(--shadow-soft)] transition hover:text-[var(--text-primary)]"
          title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
        >
          {isDark ? <Sun className="w-3.5 h-3.5 text-[var(--highlight)]" /> : <Moon className="w-3.5 h-3.5 text-[var(--text-subtle)]" />}
          <span className="hidden sm:inline capitalize">{theme} mode</span>
        </button>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-10 pt-4">
        <div className="clay-surface relative z-10 w-full max-w-5xl overflow-hidden rounded-[28px] border border-white/10 bg-[rgba(24,18,17,0.26)] shadow-[0_25px_80px_rgba(0,0,0,0.34)] backdrop-blur-[26px]">
          <div className="grid lg:grid-cols-[0.8fr_1.2fr]">
            <div className="relative flex flex-col justify-between overflow-hidden border-b border-white/10 bg-[radial-gradient(ellipse_at_76%_12%,rgba(229,189,114,0.18),transparent_34%),linear-gradient(145deg,rgba(118,77,53,0.52),rgba(34,24,21,0.38),rgba(16,12,12,0.48))] p-7 text-white lg:border-b-0 lg:border-r sm:p-9 backdrop-blur-md">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_left,rgba(156,78,53,0.14),transparent_34%)]" />
              <div className="relative">
                <div className="glass-panel glass-panel--dark inline-flex items-center gap-3 rounded-xl px-3 py-2 text-white">
                  <BrandMark name={storeSettings.storeName} className="h-11 w-11 rounded-full text-xs" />
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/80">{storeSettings.storeName}</span>
                </div>

                <div className="mt-10 space-y-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--highlight)]">Accra · Ghana</p>
                  <h1 className="brand-display text-3xl font-semibold sm:text-4xl">
                    {isSetup ? 'Set up this till' : 'POS terminal'}
                  </h1>
                  <p className="max-w-xs text-sm leading-relaxed text-white/75">
                    {isSetup
                      ? 'Create the owner account for this till. It runs entirely on this computer and needs no internet.'
                      : 'Sign in with the email and PIN your manager gave you.'}
                  </p>
                </div>
              </div>

              <div className="glass-panel glass-panel--dark relative mt-8 rounded-xl p-4 text-white">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-[var(--accent-soft)] p-2 text-[var(--highlight)]">
                    <ShieldCheck className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.18em] text-white/60">Works offline</p>
                    <p className="mt-1 text-sm font-semibold text-white">Sales are saved on this computer.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[rgba(255,255,255,0.03)] p-6 backdrop-blur-[20px] sm:p-8 lg:p-10">
              <div className="mb-8">
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--accent-strong)]">
                  {isSetup ? 'First run' : 'Secure sign in'}
                </p>
                <h2 className="mt-3 text-2xl font-black tracking-tight text-[var(--text-primary)]">
                  {isSetup ? 'Create the owner account' : 'Welcome back'}
                </h2>
                {isSetup && (
                  <p className="mt-2 text-sm text-[var(--text-muted)]">
                    This runs once. It creates the single Super Admin who can then add cashiers and managers.
                  </p>
                )}
              </div>

              {setup === 'checking' ? (
                <p className="py-8 text-center text-sm text-[var(--text-muted)]">Checking this till…</p>
              ) : (
                <form onSubmit={submit} className="space-y-4">
                  {isSetup && (
                    <div>
                      <label className="mb-1.5 block text-xs font-bold text-[var(--text-primary)]" htmlFor="setup-name">Your name</label>
                      <div className="relative">
                        <UserPlus className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                        <input
                          id="setup-name"
                          autoComplete="name"
                          value={name}
                          onChange={(e) => { setName(e.target.value); setError(null); }}
                          placeholder="e.g. Ama Boateng"
                          className={`${inputClass} pl-10`}
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="mb-1.5 block text-xs font-bold text-[var(--text-primary)]" htmlFor="login-email">Email</label>
                    <div className="relative">
                      <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                      <input
                        id="login-email"
                        type="email"
                        required
                        autoComplete="username"
                        value={email}
                        onChange={(e) => { setEmail(e.target.value); setError(null); }}
                        placeholder="you@andasmokehub.com"
                        className={`${inputClass} pl-10`}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-bold text-[var(--text-primary)]" htmlFor="login-pin">
                      {isSetup ? 'Choose a PIN' : 'PIN'}
                    </label>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                      <input
                        id="login-pin"
                        type={showPassword ? 'text' : 'password'}
                        required
                        minLength={4}
                        autoComplete={isSetup ? 'new-password' : 'current-password'}
                        value={pin}
                        onChange={(e) => { setPin(e.target.value); setError(null); }}
                        placeholder="At least 4 characters"
                        className={`${inputClass} pl-10 pr-11 font-mono tracking-wider`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((value) => !value)}
                        aria-label={showPassword ? 'Hide PIN' : 'Show PIN'}
                        className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--text-subtle)] transition hover:text-[var(--text-primary)]"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {isSetup && (
                    <div>
                      <label className="mb-1.5 block text-xs font-bold text-[var(--text-primary)]" htmlFor="setup-pin-confirm">Confirm PIN</label>
                      <div className="relative">
                        <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                        <input
                          id="setup-pin-confirm"
                          type={showPassword ? 'text' : 'password'}
                          required
                          minLength={4}
                          autoComplete="new-password"
                          value={confirmPin}
                          onChange={(e) => { setConfirmPin(e.target.value); setError(null); }}
                          placeholder="Type it again"
                          className={`${inputClass} pl-10 pr-4 font-mono tracking-wider`}
                        />
                      </div>
                    </div>
                  )}

                  {error && (
                    <div
                      role="alert"
                      className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs font-semibold text-red-600 dark:text-red-400"
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                      <span>{error}</span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isLoading}
                    className="lux-btn lux-btn--primary mt-2 flex w-full py-3.5 text-xs uppercase tracking-[0.12em] disabled:opacity-50"
                  >
                    {isLoading ? (
                      <span>{isSetup ? 'Creating…' : 'Signing in…'}</span>
                    ) : (
                      <>
                        {isSetup ? <UserPlus className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                        <span>{isSetup ? 'Create owner account' : 'Log in'}</span>
                        <ArrowRight className="ml-1 h-4 w-4" />
                      </>
                    )}
                  </button>
                </form>
              )}

              <div className="mt-8 border-t border-[var(--border-color)] pt-4 text-center">
                <p className="flex items-center justify-center gap-1.5 text-[11px] text-[var(--text-subtle)]">
                  <Store className="h-3.5 w-3.5" />
                  {storeSettings.storeName} · {storeSettings.storeAddress || 'Accra, Ghana'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="relative z-10 mx-auto w-full max-w-7xl px-6 pb-6 text-center text-xs text-[var(--text-subtle)]">
        © {new Date().getFullYear()} {storeSettings.storeName}. All rights reserved.
      </footer>
    </div>
  );
};