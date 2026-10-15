import React, { useEffect, useState, useRef } from 'react';
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
  UserPlus,
  Store,
  Clock,
  KeyRound,
  CheckCircle2,
  User,
  ChevronRight,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { BrandMark } from '../common/BrandMark';

interface AdminLoginProps {
  onSuccess: () => void;
  mode?: 'admin' | 'pos';
}

type SetupState = 'checking' | 'needed' | 'done';

interface CachedTeamMember {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar?: string;
}

export const AdminLoginView: React.FC<AdminLoginProps> = ({ onSuccess, mode = 'admin' }) => {
  const { loginAdmin, storeSettings } = useStore();
  const { showToast } = useToast();
  const { theme, toggleTheme, isDark } = useTheme();

  const [setup, setSetup] = useState<SetupState>('checking');
  const [name, setName] = useState('');
  const [email, setEmail] = useState(() => {
    try { return localStorage.getItem('anda_last_login_email') || ''; } catch { return ''; }
  });
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [showConfirmPin, setShowConfirmPin] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isShaking, setIsShaking] = useState(false);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [currentTime, setCurrentTime] = useState('');
  const [currentDate, setCurrentDate] = useState('');
  const [cachedTeam, setCachedTeam] = useState<CachedTeamMember[]>([]);
  const [selectedMember, setSelectedMember] = useState<CachedTeamMember | null>(null);
  const [manualEmailMode, setManualEmailMode] = useState(false);

  const pinInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);

  // Live Accra clock
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setCurrentTime(now.toLocaleTimeString('en-GB', { timeZone: 'Africa/Accra', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }));
      setCurrentDate(now.toLocaleDateString('en-GB', { timeZone: 'Africa/Accra', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  // Online / offline
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // Load cached team for quick-select tiles
  useEffect(() => {
    try {
      const raw = localStorage.getItem('anda_admin_accounts');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const members: CachedTeamMember[] = parsed
            .map((acc: any) => ({
              id: String(acc.id || acc.email),
              name: acc.fullName || acc.adminName || acc.name || 'Team Member',
              email: acc.email || '',
              role: acc.role || acc.adminRole || 'Staff',
              avatar: acc.avatar || acc.profileImage,
            }))
            .filter(m => Boolean(m.email));
          setCachedTeam(members);

          // Pre-select the last logged-in user
          const lastEmail = localStorage.getItem('anda_last_login_email');
          if (lastEmail) {
            const match = members.find(m => m.email.toLowerCase() === lastEmail.toLowerCase());
            if (match) { setSelectedMember(match); setEmail(match.email); }
          }
        }
      }
    } catch { /* Non-critical */ }
  }, []);

  // Check setup status
  useEffect(() => {
    let active = true;
    api.get<{ needsSetup: boolean }>('/auth?action=setup-status')
      .then(r => { if (active) setSetup(r?.needsSetup ? 'needed' : 'done'); })
      .catch(() => { if (active) setSetup('done'); });
    return () => { active = false; };
  }, []);

  const triggerShake = (msg: string) => {
    setError(msg);
    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 450);
  };

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return triggerShake("Enter the owner's full name.");
    if (!email.trim()) return triggerShake('Enter an email address.');
    if (pin.trim().length < 4) return triggerShake('PIN must be at least 4 characters.');
    if (pin !== confirmPin) return triggerShake('PINs do not match.');

    setIsLoading(true);
    try {
      const result = await api.post<{ token: string; admin: { adminName: string } }>('/auth?action=setup', {
        name: name.trim(), email: email.trim().toLowerCase(), pin: pin.trim(),
      });
      localStorage.setItem('anda_auth_token', result.token);
      localStorage.setItem('anda_last_login_email', email.trim().toLowerCase());
      const ok = await loginAdmin(pin.trim(), email.trim().toLowerCase());
      if (ok) { showToast('Till set up. Welcome!'); onSuccess(); }
      else { triggerShake('Account created. Please sign in.'); setSetup('done'); }
    } catch (err: any) {
      triggerShake(err instanceof ApiError ? err.message : 'Could not create the account.');
    } finally { setIsLoading(false); }
  };

  const handleSignIn = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError(null);
    const targetEmail = (selectedMember?.email || email).trim();
    if (!targetEmail) return triggerShake('Enter or select your email address.');
    if (!pin.trim()) return triggerShake('Enter your PIN.');

    setIsLoading(true);
    try {
      const ok = await loginAdmin(pin.trim(), targetEmail.toLowerCase());
      if (ok) {
        localStorage.setItem('anda_last_login_email', targetEmail.toLowerCase());
        showToast('Signed in successfully.');
        onSuccess();
      } else {
        setPin('');
        setTimeout(() => pinInputRef.current?.focus(), 50);
        triggerShake('Incorrect email or PIN. Please try again.');
      }
    } catch {
      triggerShake('Cannot reach the till service. Please restart the app.');
    } finally { setIsLoading(false); }
  };

  const isSetup = setup === 'needed';
  const showStaffTiles = !isSetup && cachedTeam.length > 0 && !manualEmailMode;

  const inputBase = 'lux-input w-full';

  return (
    <div
      className="relative flex min-h-screen flex-col overflow-x-hidden font-sans text-[var(--text-primary)] transition-colors duration-300 select-none"
      style={{
        background: isDark
          ? 'radial-gradient(ellipse at 14% 8%, rgba(48,195,226,0.20) 0%, transparent 44%), radial-gradient(ellipse at 90% 94%, rgba(13,111,149,0.22) 0%, transparent 46%), linear-gradient(145deg, #031d2c, #062c40 50%, #021923)'
          : 'radial-gradient(ellipse at 14% 8%, rgba(48,180,212,0.20) 0%, transparent 44%), radial-gradient(ellipse at 90% 94%, rgba(95,175,205,0.16) 0%, transparent 46%), linear-gradient(145deg, #edf9fc, #e5f3f8 50%, #f7fcfd)',
      }}
    >
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          18% { transform: translateX(-8px); }
          36% { transform: translateX(8px); }
          54% { transform: translateX(-5px); }
          72% { transform: translateX(5px); }
        }
        .login-shake { animation: shake 0.42s cubic-bezier(0.36, 0.07, 0.19, 0.97); }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .fade-in { animation: fadeSlideIn 0.3s ease both; }
      `}</style>

      {/* Brand watermark stays behind the glass surface, not inside a card. */}
      <div className="pointer-events-none fixed inset-0 flex items-center justify-center overflow-hidden">
        <img
          src="/brand-mark.png"
          alt=""
          aria-hidden="true"
          className="h-[48rem] w-[48rem] max-w-[96vw] object-contain opacity-[0.07] saturate-[0.8] dark:opacity-[0.10] dark:invert dark:hue-rotate-[145deg]"
        />
      </div>

      {/* ── Top Bar ──────────────────────────────────────────────────────────── */}
      <header className="relative z-20 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4">
        {/* Left: Brand Identity */}
        <div className="flex items-center gap-3">
          <BrandMark name={storeSettings.storeName} className="h-10 w-10 rounded-xl" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-black uppercase tracking-widest text-[var(--text-primary)]">
                {storeSettings.storeName}
              </span>
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--accent-strong)]">
                {mode === 'pos' ? 'POS Till' : 'Admin'}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)]">Accra · Ghana</p>
          </div>
        </div>

        {/* Right: Clock + Sync + Theme */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Live clock */}
          <div className="hidden items-center gap-2 rounded-full border border-[var(--border-color)] bg-[var(--bg-card)]/80 px-3.5 py-1.5 text-xs font-semibold text-[var(--text-muted)] shadow-sm backdrop-blur-md sm:flex">
            <Clock className="h-3.5 w-3.5 text-[var(--accent-strong)]" />
            <span className="font-mono text-[11px]">{currentTime || '—'}</span>
            <span className="text-[var(--border-color)]">·</span>
            <span className="text-[10px] text-[var(--text-subtle)]">{currentDate}</span>
          </div>

          {/* Connectivity */}
          <div className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-bold shadow-sm ${
            isOnline
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
          }`}>
            <span className={`h-2 w-2 rounded-full ${isOnline ? 'animate-pulse bg-emerald-500' : 'bg-amber-500'}`} />
            <span className="hidden md:inline">{isOnline ? 'Cloud Sync' : 'Offline'}</span>
          </div>

          {/* Theme toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            className="flex items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--bg-card)]/80 p-2 text-xs font-semibold text-[var(--text-muted)] shadow-sm backdrop-blur-md transition hover:scale-105 hover:text-[var(--text-primary)] sm:px-3 sm:py-1.5"
            title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
          >
            {isDark
              ? <Sun className="h-4 w-4 text-[var(--highlight)]" />
              : <Moon className="h-4 w-4 text-[var(--text-subtle)]" />}
            <span className="hidden capitalize sm:inline">{theme}</span>
          </button>
        </div>
      </header>

      {/* ── Main Card ────────────────────────────────────────────────────────── */}
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-4 sm:py-8">
        <div className={`glass-panel w-full max-w-5xl overflow-hidden rounded-3xl border transition-all duration-300 ${isShaking ? 'login-shake' : ''}`}>
          <div className="grid lg:grid-cols-[0.9fr_1.1fr]">

            {/* ── Left Panel: Brand + Info ────────────────────────────────── */}
            <div className="relative flex flex-col justify-between border-b border-[var(--border-color)] bg-[rgba(16,151,187,0.05)] p-6 lg:border-b-0 lg:border-r sm:p-8">
              <div className="space-y-6">
                {/* Brand mark + heading */}
                <div className="flex items-start gap-4">
                  <BrandMark name={storeSettings.storeName} className="h-16 w-16 rounded-2xl" />
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)] sm:text-3xl">
                      {isSetup ? 'Set up this register' : 'Point of sale'}
                    </h1>
                    <p className="mt-2 max-w-xs text-sm leading-relaxed text-[var(--text-muted)]">
                      {isSetup
                        ? 'Create the first administrator account for this register.'
                        : 'Use your email address and PIN to continue.'}
                    </p>
                  </div>
                </div>

                {/* Quick-select staff tiles (when accounts are cached) */}
                {!isSetup && cachedTeam.length > 0 && (
                  <div className="fade-in rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]/60 p-4 backdrop-blur-sm">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <User className="h-3.5 w-3.5 text-[var(--accent-strong)]" />
                        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                          Quick Select
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setManualEmailMode(m => !m);
                          if (!manualEmailMode) { setSelectedMember(null); setEmail(''); }
                        }}
                        className="text-[11px] font-semibold text-[var(--accent-strong)] underline-offset-2 hover:underline"
                      >
                        {manualEmailMode ? 'Back to roster' : 'Different account'}
                      </button>
                    </div>

                    {!manualEmailMode && (
                      <div className="grid grid-cols-2 gap-2">
                        {cachedTeam.slice(0, 4).map(member => {
                          const active = selectedMember?.email === member.email;
                          return (
                            <button
                              key={member.id}
                              type="button"
                              onClick={() => {
                                setSelectedMember(member);
                                setEmail(member.email);
                                setError(null);
                                setTimeout(() => pinInputRef.current?.focus(), 80);
                              }}
                              className={`flex items-center gap-2.5 rounded-xl border p-2.5 text-left transition-all duration-150 ${
                                active
                                  ? 'border-[var(--accent-strong)] bg-[var(--accent-soft)] shadow-sm ring-1 ring-[var(--accent-strong)]/50'
                                  : 'border-transparent bg-white/50 hover:bg-white/90 dark:bg-white/5 dark:hover:bg-white/10'
                              }`}
                            >
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-tr from-[var(--accent)] to-[var(--accent-strong)] text-xs font-bold uppercase text-white shadow-sm">
                                {member.avatar
                                  ? <img src={member.avatar} alt={member.name} className="h-full w-full rounded-lg object-cover" />
                                  : member.name.charAt(0)}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-xs font-bold text-[var(--text-primary)]">{member.name}</p>
                                <p className="truncate text-[10px] text-[var(--text-subtle)]">{member.role}</p>
                              </div>
                              {active && <CheckCircle2 className="ml-auto h-4 w-4 shrink-0 text-[var(--accent-strong)]" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

              </div>

              {/* Footer */}
              <div className="relative mt-6 flex items-center gap-2 text-xs text-[var(--text-subtle)]">
                <Store className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{storeSettings.storeName} · {storeSettings.storeAddress || 'Accra, Ghana'}</span>
              </div>
            </div>

            {/* ── Right Panel: Sign-In / Setup Form ──────────────────────── */}
            <div className="flex flex-col justify-center p-6 sm:p-8 lg:p-10">
              {setup === 'checking' ? (
                <div className="flex flex-col items-center py-16 text-center">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--border-color)] border-t-[var(--accent-strong)]" />
                  <p className="mt-4 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">Initializing till…</p>
                </div>
              ) : isSetup ? (
                /* ── FIRST-RUN SETUP ─────────────────────────────────────── */
                <form onSubmit={handleSetupSubmit} className="space-y-4">
                  <div className="mb-2">
                    <h2 className="text-xl font-bold text-[var(--text-primary)]">Create administrator account</h2>
                    <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                      This runs once and creates the primary administrator account.
                    </p>
                  </div>

                  <div>
                    <label htmlFor="setup-name" className="lux-label">Full name</label>
                    <div className="relative">
                      <UserPlus className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                      <input id="setup-name" type="text" autoFocus required
                        value={name} onChange={e => { setName(e.target.value); setError(null); }}
                        placeholder="e.g. Emmanuel Boateng" className={`${inputBase} pl-10`} />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="setup-email" className="lux-label">Email address</label>
                    <div className="relative">
                      <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                      <input id="setup-email" type="email" required
                        value={email} onChange={e => { setEmail(e.target.value); setError(null); }}
                        placeholder="admin@andasmokehub.com" className={`${inputBase} pl-10`} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="setup-pin" className="lux-label">PIN</label>
                      <div className="relative">
                        <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                        <input id="setup-pin" type={showPin ? 'text' : 'password'} required minLength={4}
                          autoComplete="new-password"
                          value={pin} onChange={e => { setPin(e.target.value); setError(null); }}
                          placeholder="Min. 4 chars" className={`${inputBase} pl-10 pr-10 font-mono`} />
                        <button type="button" onClick={() => setShowPin(p => !p)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--text-subtle)] hover:text-[var(--text-primary)]">
                          {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label htmlFor="setup-pin-confirm" className="lux-label">Confirm PIN</label>
                      <div className="relative">
                        <KeyRound className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                        <input id="setup-pin-confirm" type={showConfirmPin ? 'text' : 'password'} required minLength={4}
                          autoComplete="new-password"
                          value={confirmPin} onChange={e => { setConfirmPin(e.target.value); setError(null); }}
                          placeholder="Repeat PIN" className={`${inputBase} pl-10 pr-10 font-mono`} />
                        <button type="button" onClick={() => setShowConfirmPin(p => !p)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--text-subtle)] hover:text-[var(--text-primary)]">
                          {showConfirmPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  {error && (
                    <div role="alert" className="fade-in flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs font-semibold text-red-600 dark:text-red-400">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                      <span>{error}</span>
                    </div>
                  )}

                  <button type="submit" disabled={isLoading}
                    className="lux-btn lux-btn--primary mt-1 w-full py-3.5 text-xs uppercase tracking-wider">
                    {isLoading ? <span>Creating account…</span> : (
                      <><UserPlus className="h-4 w-4" /><span>Create account & launch POS</span><ArrowRight className="h-4 w-4" /></>
                    )}
                  </button>
                </form>
              ) : (
                /* ── STANDARD SIGN-IN ────────────────────────────────────── */
                <form onSubmit={handleSignIn} className="space-y-4">
                  <div className="mb-2">
                    <h2 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">Sign in</h2>
                    {selectedMember && !manualEmailMode && (
                      <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                        Signing in as <strong className="text-[var(--text-primary)]">{selectedMember.name}</strong>
                      </p>
                    )}
                  </div>

                  {/* Email — shows inline when no staff tiles, or when manual mode */}
                  {(!showStaffTiles || manualEmailMode) && (
                    <div className="fade-in">
                      <label htmlFor="login-email" className="lux-label">Email address</label>
                      <div className="relative">
                        <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                        <input
                          id="login-email"
                          ref={emailInputRef}
                          type="email"
                          required
                          autoFocus={!selectedMember}
                          autoComplete="username"
                          value={email}
                          onChange={e => { setEmail(e.target.value); setSelectedMember(null); setError(null); }}
                          placeholder="you@andasmokehub.com"
                          className={`${inputBase} pl-10`}
                        />
                      </div>
                    </div>
                  )}

                  {/* When a staff tile is selected, show a compact identity badge */}
                  {showStaffTiles && selectedMember && (
                    <div className="fade-in flex items-center justify-between rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]/70 px-4 py-3 backdrop-blur-sm">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-[var(--accent)] to-[var(--accent-strong)] text-sm font-bold text-white shadow-sm">
                          {selectedMember.avatar
                            ? <img src={selectedMember.avatar} alt={selectedMember.name} className="h-full w-full rounded-xl object-cover" />
                            : selectedMember.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-bold text-[var(--text-primary)]">{selectedMember.name}</p>
                          <p className="text-[11px] text-[var(--text-subtle)]">{selectedMember.email}</p>
                        </div>
                      </div>
                      <button type="button" onClick={() => setManualEmailMode(true)}
                        className="rounded-lg px-2.5 py-1 text-[11px] font-bold text-[var(--accent-strong)] hover:bg-[var(--accent-soft)] transition">
                        Change
                      </button>
                    </div>
                  )}

                  {/* When no staff tiles and no member selected */}
                  {showStaffTiles && !selectedMember && (
                    <div className="fade-in">
                      <label htmlFor="login-email" className="lux-label">Email address</label>
                      <div className="relative">
                        <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                        <input
                          id="login-email"
                          ref={emailInputRef}
                          type="email"
                          required
                          autoComplete="username"
                          value={email}
                          onChange={e => { setEmail(e.target.value); setSelectedMember(null); setError(null); }}
                          placeholder="you@andasmokehub.com"
                          className={`${inputBase} pl-10`}
                        />
                      </div>
                    </div>
                  )}

                  {/* PIN */}
                  <div>
                    <label htmlFor="login-pin" className="lux-label">PIN</label>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                      <input
                        id="login-pin"
                        ref={pinInputRef}
                        type={showPin ? 'text' : 'password'}
                        required
                        minLength={4}
                        autoComplete="current-password"
                        autoFocus={Boolean(selectedMember && !manualEmailMode)}
                        value={pin}
                        onChange={e => { setPin(e.target.value); setError(null); }}
                        placeholder="Enter your PIN"
                        className={`${inputBase} pl-10 pr-10 font-mono tracking-widest`}
                      />
                      <button type="button" onClick={() => setShowPin(p => !p)}
                        aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                        className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--text-subtle)] transition hover:text-[var(--text-primary)]">
                        {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div role="alert" className="fade-in flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs font-semibold text-red-600 dark:text-red-400">
                      <span className="h-1.5 w-1.5 shrink-0 animate-ping rounded-full bg-red-500" />
                      <span>{error}</span>
                    </div>
                  )}

                  <button type="submit" disabled={isLoading}
                    className="lux-btn lux-btn--primary mt-1 w-full py-3.5 text-xs uppercase tracking-wider">
                    {isLoading ? <span>Signing in…</span> : (
                      <><Lock className="h-4 w-4" /><span>Sign in</span><ArrowRight className="h-4 w-4" /></>
                    )}
                  </button>

                </form>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-3 text-[11px] text-[var(--text-subtle)]">
        <span>© {new Date().getFullYear()} {storeSettings.storeName}. All rights reserved.</span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          POS terminal · v1.0.0
        </span>
      </footer>
    </div>
  );
};
