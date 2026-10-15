import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  X,
  User,
  Mail,
  Phone,
  Shield,
  KeyRound,
  Camera,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  LogOut,
  Sparkles,
  Lock,
  BadgeCheck,
} from 'lucide-react';
import { useStore } from '../../../context/StoreContext';

interface AdminMyProfilePanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AdminMyProfilePanel: React.FC<AdminMyProfilePanelProps> = ({ isOpen, onClose }) => {
  const {
    adminSession,
    adminAccounts,
    updateAdminAccount,
    changeAdminPassword,
    logoutAdmin,
  } = useStore();

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Active user account resolution
  const activeAccountId = useMemo(() => {
    const sessionEmail = (adminSession?.email || '').toLowerCase().trim();
    if (!sessionEmail) return 'self';
    const match = adminAccounts.find(
      a => a?.email && a.email.toLowerCase().trim() === sessionEmail
    );
    return match?.id || adminSession?.adminId || 'self';
  }, [adminAccounts, adminSession?.email, adminSession?.adminId]);

  const activeAccount = useMemo(() => {
    return adminAccounts.find(a => a?.id === activeAccountId);
  }, [adminAccounts, activeAccountId]);

  // Profile Form state
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [avatar, setAvatar] = useState<string | undefined>(undefined);
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // Password Form state
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showCurrentPin, setShowCurrentPin] = useState(false);
  const [showNewPin, setShowNewPin] = useState(false);
  const [showConfirmPin, setShowConfirmPin] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  // Alerts
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Sync state when panel opens or session changes
  useEffect(() => {
    if (isOpen) {
      setFullName(adminSession.adminName || '');
      setEmail(adminSession.email || '');
      setPhone(adminSession.phone || activeAccount?.phone || '');
      setAvatar(adminSession.avatar || activeAccount?.avatar || undefined);
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      setAlert(null);
    }
  }, [isOpen, adminSession, activeAccount]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const showAlert = (message: string, type: 'success' | 'error' = 'success') => {
    setAlert({ type, message });
    setTimeout(() => {
      setAlert(current => (current?.message === message ? null : current));
    }, 4500);
  };

  // Image Upload with Canvas compression
  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      showAlert('Please choose an image file (JPG, PNG, WebP, or GIF).', 'error');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      showAlert('Image size exceeds 5MB. Please choose a smaller photo.', 'error');
      return;
    }

    try {
      const compressedDataUrl = await compressProfileImage(file);
      setAvatar(compressedDataUrl);
      showAlert('Photo loaded! Remember to click "Save Profile Changes" to save.', 'success');
    } catch {
      showAlert('Could not process this image. Please try another one.', 'error');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemovePhoto = () => {
    setAvatar('');
    showAlert('Photo removed. Click "Save Profile Changes" to confirm.', 'success');
  };

  const compressProfileImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = event => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX_SIZE = 256;
          let width = img.width;
          let height = img.height;

          // Square crop or proportion scale
          if (width > height) {
            if (width > MAX_SIZE) {
              height = Math.round((height * MAX_SIZE) / width);
              width = MAX_SIZE;
            }
          } else {
            if (height > MAX_SIZE) {
              width = Math.round((width * MAX_SIZE) / height);
              height = MAX_SIZE;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(String(event.target?.result || ''));
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = String(event.target?.result || '');
      };
      reader.readAsDataURL(file);
    });
  };

  // Profile Save
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) {
      showAlert('Full name cannot be empty.', 'error');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      showAlert('Please enter a valid email address.', 'error');
      return;
    }

    setIsSavingProfile(true);
    try {
      await updateAdminAccount(activeAccountId, {
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        avatar: avatar || '',
      });
      showAlert('Your profile details and photo have been updated!', 'success');
    } catch (err: any) {
      showAlert(err?.message || 'Failed to update profile details.', 'error');
    } finally {
      setIsSavingProfile(false);
    }
  };

  // Password Change
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPin) {
      showAlert('Please enter your current password / PIN.', 'error');
      return;
    }
    if (newPin.length < 4) {
      showAlert('New password / PIN must be at least 4 characters.', 'error');
      return;
    }
    if (newPin !== confirmPin) {
      showAlert('New passwords do not match. Please verify.', 'error');
      return;
    }

    setIsSavingPassword(true);
    try {
      await changeAdminPassword(currentPin, newPin);
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      showAlert('Password updated successfully! Keep your new credentials safe.', 'success');
    } catch (err: any) {
      showAlert(err?.message || 'Failed to change password. Make sure current PIN is correct.', 'error');
    } finally {
      setIsSavingPassword(false);
    }
  };

  if (!isOpen) return null;

  const roleBadgeStyle = {
    'Super Admin': 'bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-300 border-purple-200 dark:border-purple-900',
    'Store Manager': 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300 border-blue-200 dark:border-blue-900',
    'Inventory Dispatcher': 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border-amber-200 dark:border-amber-900',
    'Cashier': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  }[adminSession.adminRole] || 'bg-stone-100 text-stone-800 dark:bg-stone-800 dark:text-stone-300 border-stone-200';

  const roleDescription = {
    'Super Admin': 'Manage register access, inventory, discounts, products, and staff accounts.',
    'Store Manager': 'Manage products, stock adjustments, discounts, staff, and POS shifts.',
    'Inventory Dispatcher': 'Manage catalog items, stock adjustments, and barcode labels.',
    'Cashier': 'Record counter sales, scan products, and handle shift cash.',
  }[adminSession.adminRole];

  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-[rgba(2,25,38,0.42)] flex justify-end font-sans"
      onClick={onClose}
    >
      <div
        className="form-sheet form-sheet--side w-full max-w-xl h-full flex flex-col border-0 border-l animate-in slide-in-from-right duration-200 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-[var(--sheet-line)] flex items-center justify-between bg-[var(--sheet-head)] shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center font-bold">
              <User className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[var(--sheet-ink)] flex items-center gap-2">
                My Profile & Account
              </h2>
              <p className="text-xs text-[var(--sheet-ink-4)]">
                Manage your credentials, avatar, and security
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[var(--sheet-ink-4)] hover:text-[var(--sheet-ink)] hover:bg-[var(--sheet-hover)] transition-colors"
            aria-label="Close profile panel"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Inline Alert Banner */}
        {alert && (
          <div
            className={`mx-6 mt-4 p-3.5 rounded-xl border flex items-center gap-3 text-xs font-semibold animate-in fade-in duration-150 shrink-0 ${
              alert.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/60'
                : 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900/60'
            }`}
          >
            {alert.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <AlertCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
            )}
            <span className="flex-1">{alert.message}</span>
            <button
              type="button"
              onClick={() => setAlert(null)}
              className="text-[var(--sheet-ink-5)] hover:text-[var(--sheet-ink)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 divide-y divide-[var(--sheet-divide)]">
          {/* Section 1: Avatar & Quick Info */}
          <div className="pt-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--sheet-ink-5)] mb-4 flex items-center gap-2">
              <Camera className="h-3.5 w-3.5 text-amber-600" /> Profile Picture & Avatar
            </h3>
            <div className="flex items-center gap-5">
              {/* Avatar circle */}
              <div className="relative group shrink-0">
                <div className="h-20 w-20 rounded-2xl overflow-hidden border-2 border-amber-500/30 shadow-md bg-[var(--sheet-chip)] flex items-center justify-center text-2xl font-bold text-amber-700 dark:text-amber-400">
                  {avatar ? (
                    <img
                      src={avatar}
                      alt={fullName || 'Avatar'}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span>{(fullName || 'A').charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute -bottom-1.5 -right-1.5 p-1.5 rounded-full bg-[var(--sheet-solid)] text-[var(--sheet-solid-ink)] shadow-lg hover:scale-105 transition"
                  title="Upload profile photo"
                >
                  <Camera className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Upload Controls */}
              <div className="flex-1 min-w-0">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleImageFileChange}
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-1.5 rounded-lg border border-[var(--sheet-line-strong)] bg-[var(--sheet-button)] text-xs font-bold text-[var(--sheet-ink)] hover:bg-[var(--sheet-hover)] transition"
                  >
                    Change Photo
                  </button>
                  {avatar && (
                    <button
                      type="button"
                      onClick={handleRemovePhoto}
                      className="px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900/40 text-xs font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 transition flex items-center gap-1"
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[11px] text-[var(--sheet-ink-4)]">
                  JPG, PNG, or WebP. Automatically optimized for fast dashboard load.
                </p>
              </div>
            </div>
          </div>

          {/* Section 2: Personal Information Form */}
          <form onSubmit={handleSaveProfile} className="pt-6 space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--sheet-ink-5)] mb-2 flex items-center gap-2">
              <User className="h-3.5 w-3.5 text-amber-600" /> Personal Details
            </h3>

            <div>
              <label className="block text-xs font-bold text-[var(--sheet-ink-2)] mb-1">
                Display Name *
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--sheet-ink-5)]" />
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  placeholder="e.g. Ama Boateng"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[var(--sheet-line-strong)] bg-[var(--sheet-field)] text-sm font-medium text-[var(--sheet-ink)] outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-[var(--sheet-ink-2)] mb-1">
                Email Address *
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--sheet-ink-5)]" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="e.g. staff@store.com"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[var(--sheet-line-strong)] bg-[var(--sheet-field)] text-sm font-medium text-[var(--sheet-ink)] outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-[var(--sheet-ink-2)] mb-1">
                Phone Number
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--sheet-ink-5)]" />
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="e.g. 0244123456"
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[var(--sheet-line-strong)] bg-[var(--sheet-field)] text-sm font-medium text-[var(--sheet-ink)] outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition"
                />
              </div>
            </div>

            {/* Role Display (Read-Only) */}
            <div className="rounded-xl border border-[var(--sheet-line)] bg-[var(--sheet-panel)] p-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-[var(--sheet-ink-5)]" />
                  <span className="text-xs font-bold text-[var(--sheet-ink-2)]">
                    Assigned Role
                  </span>
                </div>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${roleBadgeStyle}`}>
                  <BadgeCheck className="h-3.5 w-3.5" />
                  {adminSession.adminRole}
                </span>
              </div>
              <p className="mt-2 text-[11px] text-[var(--sheet-ink-4)] leading-relaxed">
                {roleDescription}
              </p>
            </div>

            <button
              type="submit"
              disabled={isSavingProfile}
              className="w-full py-2.5 px-4 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-sm transition disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isSavingProfile ? (
                <>Saving Changes...</>
              ) : (
                <>
                Save Profile Changes
                </>
              )}
            </button>
          </form>

          {/* Section 3: Password / PIN Change Form */}
          <form onSubmit={handleChangePassword} className="pt-6 space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--sheet-ink-5)] mb-1 flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 text-amber-600" /> Change Password / PIN
            </h3>
            <p className="text-xs text-[var(--sheet-ink-4)]">
              Used when signing in to the admin portal or logging onto the POS counter station.
            </p>

            <div>
              <label className="block text-xs font-bold text-[var(--sheet-ink-2)] mb-1">
                Current Password / PIN *
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--sheet-ink-5)]" />
                <input
                  type={showCurrentPin ? 'text' : 'password'}
                  required
                  value={currentPin}
                  onChange={e => setCurrentPin(e.target.value)}
                  placeholder="Enter current PIN / password"
                  className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-[var(--sheet-line-strong)] bg-[var(--sheet-field)] text-sm font-medium text-[var(--sheet-ink)] outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPin(!showCurrentPin)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--sheet-ink-5)] hover:text-[var(--sheet-ink)]"
                >
                  {showCurrentPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-[var(--sheet-ink-2)] mb-1">
                  New Password / PIN *
                </label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--sheet-ink-5)]" />
                  <input
                    type={showNewPin ? 'text' : 'password'}
                    required
                    value={newPin}
                    onChange={e => setNewPin(e.target.value)}
                    placeholder="Min 4 characters"
                    className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-[var(--sheet-line-strong)] bg-[var(--sheet-field)] text-sm font-medium text-[var(--sheet-ink)] outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPin(!showNewPin)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--sheet-ink-5)] hover:text-[var(--sheet-ink)]"
                  >
                    {showNewPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-[var(--sheet-ink-2)] mb-1">
                  Confirm Password *
                </label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--sheet-ink-5)]" />
                  <input
                    type={showConfirmPin ? 'text' : 'password'}
                    required
                    value={confirmPin}
                    onChange={e => setConfirmPin(e.target.value)}
                    placeholder="Re-enter new password"
                    className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-[var(--sheet-line-strong)] bg-[var(--sheet-field)] text-sm font-medium text-[var(--sheet-ink)] outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPin(!showConfirmPin)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--sheet-ink-5)] hover:text-[var(--sheet-ink)]"
                  >
                    {showConfirmPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSavingPassword || !newPin || !currentPin}
              className="w-full py-2.5 px-4 rounded-xl bg-[var(--sheet-solid)] hover:bg-[var(--sheet-solid-hover)] text-[var(--sheet-solid-ink)] font-bold text-xs shadow-sm transition disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isSavingPassword ? 'Updating Password...' : 'Update Password & PIN'}
            </button>
          </form>

          {/* Section 4: Session Security & Sign Out */}
          <div className="pt-6 pb-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--sheet-ink-5)] mb-3 flex items-center gap-2">
              <Shield className="h-3.5 w-3.5 text-[var(--sheet-ink-4)]" /> Active Session
            </h3>

            <div className="rounded-xl border border-[var(--sheet-line)] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[var(--sheet-panel)]">
              <div className="space-y-0.5">
                <p className="text-xs font-bold text-[var(--sheet-ink)]">
                  Signed in as {adminSession.adminName}
                </p>
                <p className="text-[11px] text-[var(--sheet-ink-4)]">
                  {adminSession.email} · {adminSession.adminRole}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  void logoutAdmin();
                }}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400 text-xs font-bold hover:bg-red-100 dark:hover:bg-red-950/50 transition self-start sm:self-auto"
              >
                <LogOut className="h-3.5 w-3.5" /> Sign Out
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
