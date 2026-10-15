import React, { useEffect, useState, useCallback, useRef } from 'react';
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
  Delete,
  RotateCcw,
  Wifi,
  WifiOff,
  Clock,
  Sparkles,
  KeyRound,
  CheckCircle2,
  ChevronRight,
  User,
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
    try {
      return localStorage.getItem('anda_last_login_email') || '';
    } catch {
      return '';
    }
  });
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isShaking, setIsShaking] = useState(false);
  const [activeNumpadKey, setActiveNumpadKey] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [currentTime, setCurrentTime] = useState('');
  const [currentDate, setCurrentDate] = useState('');
  const [cachedTeam, setCachedTeam] = useState<CachedTeamMember[]>([]);
  const [selectedMemberEmail, setSelectedMemberEmail] = useState<string | null>(null);
  const [manualEmailMode, setManualEmailMode] = useState(false);

  const pinContainerRef = useRef<HTMLDivElement>(null);

  // Live Accra digital clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString('en-GB', {
          timeZone: 'Africa/Accra',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
        })
      );
      setCurrentDate(
        now.toLocaleDateString('en-GB', {
          timeZone: 'Africa/Accra',
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      );
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Online / Offline monitor
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Load cached team accounts for 1-tap cashier selection
  useEffect(() => {
    try {
      const rawAccounts = localStorage.getItem('anda_admin_accounts');
      if (rawAccounts) {
        const parsed = JSON.parse(rawAccounts);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const members: CachedTeamMember[] = parsed.map((acc: any) => ({
            id: String(acc.id || acc.email),
            name: acc.fullName || acc.adminName || acc.name || 'Team Member',
            email: acc.email || '',
            role: acc.role || acc.adminRole || 'Cashier',
            avatar: acc.avatar || acc.profileImage,
          })).filter(m => Boolean(m.email));

          setCachedTeam(members);

          // If we had a remembered email, select them by default
          const lastEmail = localStorage.getItem('anda_last_login_email');
          if (lastEmail) {
            const match = members.find(m => m.email.toLowerCase() === lastEmail.toLowerCase());
            if (match) {
              setSelectedMemberEmail(match.email);
            }
          }
        }
      }
    } catch {
      // Non-critical cache read
    }
  }, []);

  // Check setup status
  useEffect(() => {
    let active = true;
    api.get<{ needsSetup: boolean }>('/auth?action=setup-status')
      .then((result) => { if (active) setSetup(result?.needsSetup ? 'needed' : 'done'); })
      .catch(() => { if (active) setSetup('done'); });
    return () => { active = false; };
  }, []);

  const triggerErrorShake = (msg: string) => {
    setError(msg);
    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 500);
  };

  const handleSetupSubmit = async (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    setError(null);
    if (name.trim().length < 2) return triggerErrorShake('Enter the owner’s name.');
    if (!email.trim()) return triggerErrorShake('Enter an email address for this account.');
    if (pin.trim().length < 4) return triggerErrorShake('The PIN must be at least 4 characters.');
    if (pin !== confirmPin) return triggerErrorShake('The two PINs do not match.');

    setIsLoading(true);
    try {
      const result = await api.post<{ token: string; admin: { adminName: string } }>('/auth?action=setup', {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        pin: pin.trim(),
      });
      localStorage.setItem('anda_auth_token', result.token);
      localStorage.setItem('anda_last_login_email', email.trim().toLowerCase());
      const signedIn = await loginAdmin(pin.trim(), email.trim().toLowerCase());
      if (signedIn) {
        showToast('Till set up. Welcome!');
        onSuccess();
      } else {
        triggerErrorShake('Account created. Please sign in.');
        setSetup('done');
      }
    } catch (caught: any) {
      triggerErrorShake(caught instanceof ApiError ? caught.message : 'Could not create the owner account.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignIn = async (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    setError(null);
    const targetEmail = (selectedMemberEmail || email).trim();
    if (!targetEmail) return triggerErrorShake('Please select a cashier profile or enter your email.');
    if (!pin.trim()) return triggerErrorShake('Enter your PIN to sign in.');

    setIsLoading(true);
    try {
      const success = await loginAdmin(pin.trim(), targetEmail.toLowerCase());
      if (success) {
        localStorage.setItem('anda_last_login_email', targetEmail.toLowerCase());
        showToast('Welcome back! Terminal unlocked.');
        onSuccess();
      } else {
        setPin('');
        triggerErrorShake('Incorrect PIN or email. Please verify and try again.');
      }
    } catch {
      triggerErrorShake('Cannot reach the till service. Please verify server connection.');
    } finally {
      setIsLoading(false);
    }
  };

  const isSetup = setup === 'needed';

  // Numpad key handlers
  const handleNumpadPress = useCallback((digit: string) => {
    setError(null);
    setActiveNumpadKey(digit);
    setTimeout(() => setActiveNumpadKey(null), 150);

    setPin(prev => {
      if (prev.length >= 10) return prev;
      return prev + digit;
    });
  }, []);

  const handleNumpadClear = useCallback(() => {
    setError(null);
    setPin('');
    setActiveNumpadKey('C');
    setTimeout(() => setActiveNumpadKey(null), 150);
  }, []);

  const handleNumpadBackspace = useCallback(() => {
    setError(null);
    setPin(prev => prev.slice(0, -1));
    setActiveNumpadKey('backspace');
    setTimeout(() => setActiveNumpadKey(null), 150);
  }, []);

  // Physical keyboard listener for touchscreen terminal / hardware numpad
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // If user is currently focused in a text input (like Name or Email), do not hijack typing
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      const isInputFocused = activeTag === 'input' || activeTag === 'textarea';

      if (isSetup) {
        // In setup mode, standard inputs handle keyboard
        return;
      }

      if (isInputFocused && document.activeElement?.id === 'manual-email-input') {
        if (e.key === 'Enter') {
          e.preventDefault();
          (document.activeElement as HTMLElement)?.blur();
          return;
        }
        return;
      }

      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleNumpadPress(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleNumpadBackspace();
      } else if (e.key === 'Escape' || e.key === 'Delete') {
        e.preventDefault();
        handleNumpadClear();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (pin.length >= 1 && !isLoading) {
          handleSignIn();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSetup, pin, isLoading, handleNumpadPress, handleNumpadBackspace, handleNumpadClear]);

  const numpadButtons = [
    { key: '1', sub: '' },
    { key: '2', sub: 'ABC' },
    { key: '3', sub: 'DEF' },
    { key: '4', sub: 'GHI' },
    { key: '5', sub: 'JKL' },
    { key: '6', sub: 'MNO' },
    { key: '7', sub: 'PQRS' },
    { key: '8', sub: 'TUV' },
    { key: '9', sub: 'WXYZ' },
    { key: 'C', sub: 'CLEAR', isAction: true },
    { key: '0', sub: 'OPER' },
    { key: 'DEL', sub: 'BACK', isAction: true },
  ];

  const currentEmailDisplay = selectedMemberEmail || email;
  const selectedMember = cachedTeam.find(m => m.email.toLowerCase() === currentEmailDisplay.toLowerCase());

  return (
    <div
      className="relative min-h-screen flex flex-col justify-between overflow-x-hidden text-[var(--text-primary)] font-sans transition-colors duration-300 select-none"
      style={{
        background: isDark
          ? 'radial-gradient(circle at 15% 15%, rgba(197,150,81,0.18), transparent 40%), radial-gradient(circle at 85% 85%, rgba(71,123,104,0.14), transparent 45%), linear-gradient(135deg, #16110e, #130d0b 46%, #0a0807)'
          : 'radial-gradient(circle at 15% 15%, rgba(197,150,81,0.14), transparent 40%), radial-gradient(circle at 85% 85%, rgba(71,123,104,0.10), transparent 45%), linear-gradient(135deg, #fdfbf7, #f7f1e7 46%, #eef4f0)',
      }}
    >
      <style>{`
        @keyframes subtleShake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }
        .login-shake {
          animation: subtleShake 0.4s ease-in-out;
        }
      `}</style>

      {/* Decorative ambient background brand marks */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden opacity-[0.06] dark:opacity-[0.08]">
        <div className="absolute -top-32 -left-32 h-[38rem] w-[38rem] rounded-full border border-[var(--accent-strong)]/30 blur-2xl" />
        <div className="absolute -bottom-32 -right-32 h-[38rem] w-[38rem] rounded-full border border-[var(--jade)]/30 blur-2xl" />
        <div className="absolute inset-0 flex items-center justify-center">
          <BrandMark
            name={storeSettings.storeName}
            className="h-[36rem] w-[36rem] rounded-[32%] border border-white/5 opacity-40 filter drop-shadow-2xl"
          />
        </div>
      </div>

      {/* Top Application Bar */}
      <header className="relative z-20 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4">
        {/* Left: Terminal Identity & Status */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/20 bg-white/10 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-white/5">
            <BrandMark name={storeSettings.storeName} className="h-8 w-8 rounded-lg" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-black tracking-wider text-[var(--text-primary)] uppercase">
                {storeSettings.storeName}
              </span>
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--accent-strong)]">
                {mode === 'pos' ? 'POS Till #01' : 'Admin'}
              </span>
            </div>
            <p className="text-[11px] font-medium text-[var(--text-muted)]">
              Accra Lounge Terminal
            </p>
          </div>
        </div>

        {/* Right: Live Clock, Connectivity Pill & Theme Toggle */}
        <div className="flex items-center gap-2.5 sm:gap-3">
          {/* Live Clock Pill */}
          <div className="hidden sm:flex items-center gap-2 rounded-full border border-[var(--border-color)] bg-[var(--bg-card)]/80 px-3.5 py-1.5 text-xs font-semibold text-[var(--text-muted)] shadow-sm backdrop-blur-md">
            <Clock className="h-3.5 w-3.5 text-[var(--accent-strong)]" />
            <span className="font-mono text-[11px] tracking-tight">{currentTime || '12:00:00 PM'}</span>
            <span className="text-stone-300 dark:text-stone-600">•</span>
            <span className="text-[10px] text-[var(--text-subtle)]">{currentDate}</span>
          </div>

          {/* Sync / Offline Status */}
          <div
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-bold shadow-sm backdrop-blur-md ${
              isOnline
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
            }`}
            title={isOnline ? 'Cloud sync active & connected' : 'Working offline. Actions will sync when online.'}
          >
            <span className={`h-2 w-2 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
            {isOnline ? (
              <span className="hidden md:inline">Live Cloud Sync</span>
            ) : (
              <span className="hidden md:inline">Offline Mode</span>
            )}
          </div>

          {/* Theme switcher */}
          <button
            type="button"
            onClick={toggleTheme}
            className="flex items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--bg-card)]/80 p-2 sm:px-3 sm:py-1.5 text-xs font-semibold text-[var(--text-muted)] shadow-sm backdrop-blur-md transition hover:scale-105 hover:text-[var(--text-primary)]"
            title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
          >
            {isDark ? (
              <Sun className="h-4 w-4 text-[var(--highlight)] transition-transform hover:rotate-45" />
            ) : (
              <Moon className="h-4 w-4 text-[var(--text-subtle)] transition-transform hover:-rotate-12" />
            )}
            <span className="hidden sm:inline capitalize">{theme}</span>
          </button>
        </div>
      </header>

      {/* Main Terminal Shell */}
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-3 sm:py-6">
        <div
          className={`w-full max-w-4xl overflow-hidden rounded-3xl border border-white/20 bg-white/70 shadow-[0_24px_70px_rgba(30,20,10,0.16)] backdrop-blur-xl dark:border-white/10 dark:bg-[#191310]/80 dark:shadow-[0_24px_70px_rgba(0,0,0,0.5)] transition-all duration-300 ${
            isShaking ? 'login-shake' : ''
          }`}
        >
          <div className="grid lg:grid-cols-[1fr_1.15fr]">
            {/* Left Column: Ambient Brand Display & Cashier Quick Select */}
            <div className="relative flex flex-col justify-between overflow-hidden border-b border-stone-200/50 p-6 dark:border-white/10 lg:border-b-0 lg:border-r sm:p-8 bg-gradient-to-br from-amber-500/10 via-stone-500/5 to-transparent">
              <div className="relative z-10 space-y-6">
                {/* Brand Seal & Header */}
                <div className="flex items-start gap-4">
                  <div className="relative">
                    <BrandMark
                      name={storeSettings.storeName}
                      className="h-16 w-16 rounded-2xl border border-[var(--accent-strong)]/30 shadow-lg"
                    />
                    <div className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/20 bg-emerald-500 text-white shadow-sm">
                      <Sparkles className="h-3 w-3" />
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] font-black uppercase tracking-[0.24em] text-[var(--accent-strong)]">
                      Authorized POS Terminal
                    </span>
                    <h1 className="mt-0.5 text-2xl font-black tracking-tight text-[var(--text-primary)] sm:text-3xl">
                      {isSetup ? 'Initial Register Setup' : 'Terminal Unlock'}
                    </h1>
                    <p className="mt-1 text-xs text-[var(--text-muted)] leading-relaxed">
                      {isSetup
                        ? 'Configure the primary super admin for this point-of-sale register.'
                        : 'Tap your staff profile or enter your secure PIN to begin transactions.'}
                    </p>
                  </div>
                </div>

                {/* Quick Staff Roster (if accounts are cached from prior logins) */}
                {!isSetup && cachedTeam.length > 0 && (
                  <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]/50 p-4 backdrop-blur-md">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <User className="h-3.5 w-3.5 text-[var(--accent-strong)]" />
                        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                          Select Cashier
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setManualEmailMode(!manualEmailMode);
                          if (!manualEmailMode) setSelectedMemberEmail(null);
                        }}
                        className="text-[11px] font-semibold text-[var(--accent-strong)] hover:underline"
                      >
                        {manualEmailMode ? 'Back to staff tiles' : 'Manual email'}
                      </button>
                    </div>

                    {!manualEmailMode && (
                      <div className="grid grid-cols-2 gap-2">
                        {cachedTeam.slice(0, 4).map((member) => {
                          const isSelected = (selectedMemberEmail || email).toLowerCase() === member.email.toLowerCase();
                          return (
                            <button
                              key={member.id}
                              type="button"
                              onClick={() => {
                                setSelectedMemberEmail(member.email);
                                setEmail(member.email);
                                setError(null);
                              }}
                              className={`flex items-center gap-2.5 rounded-xl border p-2 text-left transition-all ${
                                isSelected
                                  ? 'border-[var(--accent-strong)] bg-[var(--accent-soft)] shadow-md ring-1 ring-[var(--accent-strong)]'
                                  : 'border-transparent bg-white/40 hover:bg-white/80 dark:bg-white/5 dark:hover:bg-white/10'
                              }`}
                            >
                              <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-gradient-to-tr from-amber-600 to-stone-500 font-bold text-xs text-white uppercase shadow-sm">
                                {member.avatar ? (
                                  <img src={member.avatar} alt={member.name} className="h-full w-full rounded-lg object-cover" />
                                ) : (
                                  member.name.charAt(0)
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-bold text-[var(--text-primary)]">
                                  {member.name}
                                </p>
                                <p className="truncate text-[10px] text-[var(--text-subtle)] font-medium">
                                  {member.role}
                                </p>
                              </div>
                              {isSelected && (
                                <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--accent-strong)]" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Cloud & Security Specs */}
                <div className="space-y-2 rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]/40 p-3.5 backdrop-blur-md">
                  <div className="flex items-center gap-2.5">
                    <ShieldCheck className="h-4 w-4 text-emerald-500 shrink-0" />
                    <div>
                      <p className="text-xs font-bold text-[var(--text-primary)]">End-to-End Encrypted Till</p>
                      <p className="text-[11px] text-[var(--text-subtle)]">
                        Local transactions store offline and stream live to central cloud.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between border-t border-[var(--border-color)]/50 pt-2 text-[10px] font-semibold text-[var(--text-muted)]">
                    <span>Register: TILL-01-MAIN</span>
                    <span>Version 1.0.0</span>
                  </div>
                </div>
              </div>

              {/* Store Footer Address */}
              <div className="relative z-10 mt-6 flex items-center gap-2 text-xs text-[var(--text-subtle)]">
                <Store className="h-3.5 w-3.5 shrink-0 text-[var(--accent-strong)]" />
                <span className="truncate">
                  {storeSettings.storeName} • {storeSettings.storeAddress || 'Accra, Ghana'}
                </span>
              </div>
            </div>

            {/* Right Column: Keypad & Input Form */}
            <div className="p-6 sm:p-8 flex flex-col justify-center">
              {setup === 'checking' ? (
                <div className="py-16 text-center">
                  <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[var(--border-color)] border-t-[var(--accent-strong)]" />
                  <p className="mt-4 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
                    Initializing POS Terminal…
                  </p>
                </div>
              ) : isSetup ? (
                /* ── FIRST-RUN SETUP FORM ── */
                <form onSubmit={handleSetupSubmit} className="space-y-4">
                  <div className="mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--accent-strong)]">
                      First Launch Wizard
                    </span>
                    <h2 className="mt-1 text-xl font-black text-[var(--text-primary)]">Create Super Admin</h2>
                    <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                      Set up the primary administrative owner for this till.
                    </p>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-bold text-[var(--text-primary)]" htmlFor="setup-name">
                      Owner / Admin Full Name
                    </label>
                    <div className="relative">
                      <UserPlus className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                      <input
                        id="setup-name"
                        type="text"
                        required
                        autoFocus
                        value={name}
                        onChange={(e) => { setName(e.target.value); setError(null); }}
                        placeholder="e.g. Emmanuel Boateng"
                        className="lux-input pl-10"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-bold text-[var(--text-primary)]" htmlFor="setup-email">
                      Admin Email Address
                    </label>
                    <div className="relative">
                      <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                      <input
                        id="setup-email"
                        type="email"
                        required
                        value={email}
                        onChange={(e) => { setEmail(e.target.value); setError(null); }}
                        placeholder="admin@andasmokehub.com"
                        className="lux-input pl-10"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-bold text-[var(--text-primary)]" htmlFor="setup-pin">
                        Security PIN
                      </label>
                      <div className="relative">
                        <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                        <input
                          id="setup-pin"
                          type={showPassword ? 'text' : 'password'}
                          required
                          minLength={4}
                          value={pin}
                          onChange={(e) => { setPin(e.target.value); setError(null); }}
                          placeholder="Min 4 digits"
                          className="lux-input pl-10 pr-9 font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(p => !p)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[var(--text-subtle)]"
                        >
                          {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-bold text-[var(--text-primary)]" htmlFor="setup-pin-confirm">
                        Confirm PIN
                      </label>
                      <div className="relative">
                        <KeyRound className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                        <input
                          id="setup-pin-confirm"
                          type={showPassword ? 'text' : 'password'}
                          required
                          minLength={4}
                          value={confirmPin}
                          onChange={(e) => { setConfirmPin(e.target.value); setError(null); }}
                          placeholder="Repeat PIN"
                          className="lux-input pl-10 font-mono"
                        />
                      </div>
                    </div>
                  </div>

                  {error && (
                    <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs font-semibold text-red-600 dark:text-red-400">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                      <span>{error}</span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isLoading}
                    className="lux-btn lux-btn--primary w-full py-3.5 text-xs font-bold uppercase tracking-wider shadow-lg transition-transform active:scale-98"
                  >
                    {isLoading ? (
                      <span>Initializing Terminal…</span>
                    ) : (
                      <>
                        <UserPlus className="h-4 w-4 mr-2" />
                        <span>Complete Setup & Launch POS</span>
                        <ArrowRight className="h-4 w-4 ml-2" />
                      </>
                    )}
                  </button>
                </form>
              ) : (
                /* ── STANDARD POS SIGN-IN (TACTILE NUMPAD) ── */
                <div className="space-y-4">
                  {/* Selected User Badge / Manual Email Input */}
                  {(manualEmailMode || cachedTeam.length === 0) ? (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-bold text-[var(--text-primary)]" htmlFor="manual-email-input">
                          Staff Email
                        </label>
                        {cachedTeam.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setManualEmailMode(false)}
                            className="text-[11px] font-semibold text-[var(--accent-strong)] hover:underline"
                          >
                            Select from staff roster
                          </button>
                        )}
                      </div>
                      <div className="relative">
                        <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                        <input
                          id="manual-email-input"
                          type="email"
                          required
                          value={email}
                          onChange={(e) => {
                            setEmail(e.target.value);
                            setSelectedMemberEmail(null);
                            setError(null);
                          }}
                          placeholder="staff@andasmokehub.com"
                          className="lux-input pl-10"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]/70 px-4 py-2.5 backdrop-blur-md shadow-sm">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-[var(--accent)] to-[var(--accent-strong)] text-white font-bold text-sm shadow-sm">
                          {selectedMember?.avatar ? (
                            <img src={selectedMember.avatar} alt={selectedMember.name} className="h-full w-full rounded-xl object-cover" />
                          ) : (
                            (selectedMember?.name || currentEmailDisplay || 'A').charAt(0).toUpperCase()
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-bold text-[var(--text-primary)]">
                            {selectedMember?.name || currentEmailDisplay || 'Select Account'}
                          </p>
                          <p className="text-[10px] text-[var(--text-subtle)] font-medium">
                            {selectedMember?.role || 'Authorized Staff'}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setManualEmailMode(true)}
                        className="rounded-lg px-2.5 py-1 text-[11px] font-bold text-[var(--accent-strong)] hover:bg-[var(--accent-soft)] transition"
                      >
                        Change
                      </button>
                    </div>
                  )}

                  {/* Tactile PIN Bullet Slot Display */}
                  <div
                    ref={pinContainerRef}
                    className="relative flex flex-col items-center justify-center rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]/90 p-4 shadow-inner dark:bg-black/20"
                  >
                    <div className="flex items-center justify-between w-full mb-2 px-1">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-subtle)]">
                        Enter Security PIN
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowPassword(p => !p)}
                        className="flex items-center gap-1 text-[11px] font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        title={showPassword ? 'Mask PIN' : 'Reveal PIN'}
                      >
                        {showPassword ? (
                          <>
                            <EyeOff className="h-3 w-3" />
                            <span>Hide</span>
                          </>
                        ) : (
                          <>
                            <Eye className="h-3 w-3" />
                            <span>Peek</span>
                          </>
                        )}
                      </button>
                    </div>

                    {/* PIN Bullets */}
                    <div className="my-1 flex items-center justify-center gap-3 h-10">
                      {Array.from({ length: Math.max(4, pin.length) }).map((_, idx) => {
                        const isFilled = idx < pin.length;
                        const char = pin[idx];
                        return (
                          <div
                            key={idx}
                            className={`flex h-8 w-8 items-center justify-center rounded-xl border text-sm font-bold font-mono transition-all duration-150 ${
                              isFilled
                                ? 'border-[var(--accent-strong)] bg-gradient-to-tr from-[var(--accent)] to-[var(--accent-strong)] text-white shadow-[0_0_12px_rgba(197,150,81,0.5)] scale-105'
                                : 'border-stone-300 bg-stone-100/50 text-transparent dark:border-stone-700 dark:bg-white/5'
                            }`}
                          >
                            {isFilled ? (showPassword ? char : '●') : '○'}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Error Notification */}
                  {error && (
                    <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-2.5 text-xs font-semibold text-red-600 dark:text-red-400">
                      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500 animate-ping" />
                      <span>{error}</span>
                    </div>
                  )}

                  {/* On-Screen Tactile Numeric Keypad */}
                  <div className="grid grid-cols-3 gap-2 sm:gap-2.5 pt-1">
                    {numpadButtons.map((btn) => {
                      const isActive = activeNumpadKey === btn.key || (btn.key === 'DEL' && activeNumpadKey === 'backspace');
                      return (
                        <button
                          key={btn.key}
                          type="button"
                          onClick={() => {
                            if (btn.key === 'C') handleNumpadClear();
                            else if (btn.key === 'DEL') handleNumpadBackspace();
                            else handleNumpadPress(btn.key);
                          }}
                          className={`group relative flex flex-col items-center justify-center rounded-2xl border py-3 sm:py-3.5 transition-all active:scale-95 touch-manipulation ${
                            btn.isAction
                              ? 'border-[var(--border-color)] bg-[var(--bg-soft)] text-[var(--text-muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)]'
                              : 'border-stone-200/80 bg-white/90 text-[var(--text-primary)] shadow-sm hover:border-[var(--accent-strong)]/40 hover:bg-stone-50 dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]'
                          } ${
                            isActive
                              ? 'ring-2 ring-[var(--accent-strong)] bg-[var(--accent-soft)] scale-95'
                              : ''
                          }`}
                        >
                          <span className="text-xl sm:text-2xl font-black tracking-tight leading-none">
                            {btn.key === 'DEL' ? (
                              <Delete className="h-5 w-5 sm:h-6 sm:w-6" />
                            ) : btn.key === 'C' ? (
                              <RotateCcw className="h-4 w-4 sm:h-5 sm:w-5" />
                            ) : (
                              btn.key
                            )}
                          </span>
                          {btn.sub && (
                            <span className="mt-0.5 text-[9px] font-bold tracking-widest text-[var(--text-subtle)] uppercase">
                              {btn.sub}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Submit / Unlock Action Button */}
                  <button
                    type="button"
                    onClick={() => handleSignIn()}
                    disabled={isLoading || pin.length === 0}
                    className="lux-btn lux-btn--primary w-full py-3.5 text-xs font-bold uppercase tracking-wider shadow-lg transition-transform active:scale-98 disabled:opacity-40"
                  >
                    {isLoading ? (
                      <span>Verifying Credentials…</span>
                    ) : (
                      <>
                        <Lock className="h-4 w-4 mr-2" />
                        <span>Unlock Register & Open POS</span>
                        <ArrowRight className="h-4 w-4 ml-2" />
                      </>
                    )}
                  </button>

                  <p className="text-center text-[10px] text-[var(--text-subtle)] font-medium">
                    Physical numpad supported • Press <kbd className="rounded bg-black/10 dark:bg-white/10 px-1 py-0.5 font-mono">Enter</kbd> to unlock
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Terminal Footer */}
      <footer className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-3 text-[11px] text-[var(--text-subtle)] font-medium">
        <span>© {new Date().getFullYear()} {storeSettings.storeName}. All rights reserved.</span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Terminal Secure
        </span>
      </footer>
    </div>
  );
};