import React, { useState, useMemo } from 'react';
import {
  User,
  Mail,
  Phone,
  Shield,
  Edit3,
  Trash2,
  Check,
  X,
  Plus,
  Search,
  Key,
  UserCheck,
  AlertTriangle,
} from 'lucide-react';
import { useStore } from '../../../context/StoreContext';
import { useAlert } from '../../../context/AlertContext';
import { AdminAccount } from '../../../types';
import { AdminPageHeader } from '../components/AdminPrimitives';

const ROLE_BADGE: Record<string, string> = {
  super_admin: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  admin:       'bg-[var(--violet-soft)] text-[var(--violet)]',
  manager:     'bg-[color-mix(in_srgb,var(--highlight)_16%,transparent)] text-[var(--highlight)]',
  cashier:     'bg-[var(--jade-soft)] text-[var(--jade)]',
  Cashier:     'bg-[var(--jade-soft)] text-[var(--jade)]',
};

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  admin:       'Admin',
  manager:     'Manager',
  cashier:     'POS Cashier',
  Cashier:     'POS Cashier',
  'Super Admin': 'Super Admin',
  'Store Manager': 'Store Manager',
  'Inventory Dispatcher': 'Inventory Dispatcher',
};

export const AdminAccountsManagementScreen: React.FC = () => {
  const { adminAccounts = [], adminSession, updateAdminAccount, addAdminAccount, deleteAdminAccount, changeAdminPassword, fetchAdminAccounts } = useStore();
  const { showAlert } = useAlert();

  const [searchTerm, setSearchTerm] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [editForm, setEditForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    role: 'admin' as AdminAccount['role'],
  });

  const [profileForm, setProfileForm] = useState({ fullName: '', email: '', phone: '' });
  const [passwordForm, setPasswordForm] = useState({ current: '', next: '', confirm: '' });
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const hasFetched = React.useRef(false);
  React.useEffect(() => {
    if (!hasFetched.current) {
      hasFetched.current = true;
      void fetchAdminAccounts();
    }
  }, [fetchAdminAccounts]);

  const safeAccounts = useMemo(() => {
    return Array.isArray(adminAccounts) ? adminAccounts.filter(Boolean) : [];
  }, [adminAccounts]);

  const currentAdminAccountId = useMemo(() => {
    const sessionEmail = (adminSession?.email || '').toLowerCase().trim();
    if (!sessionEmail) return 'self';
    const match = safeAccounts.find(
      a => a?.email && a.email.toLowerCase().trim() === sessionEmail
    );
    return match?.id ?? 'self';
  }, [safeAccounts, adminSession?.email]);

  const currentAdminProfile = useMemo(
    () => ({
      id: currentAdminAccountId,
      fullName: adminSession?.adminName || 'Store Administrator',
      email: adminSession?.email || '',
      phone: safeAccounts.find(a => a?.id === currentAdminAccountId)?.phone || '',
      role: (adminSession?.adminRole === 'Super Admin'
        ? 'super_admin'
        : adminSession?.adminRole === 'Store Manager'
        ? 'manager'
        : adminSession?.adminRole === 'Cashier'
        ? 'cashier'
        : 'admin') as AdminAccount['role'],
    }),
    [safeAccounts, adminSession, currentAdminAccountId]
  );

  React.useEffect(() => {
    setProfileForm({
      fullName: currentAdminProfile.fullName || '',
      email: currentAdminProfile.email || '',
      phone: currentAdminProfile.phone || '',
    });
  }, [currentAdminProfile.fullName, currentAdminProfile.email, currentAdminProfile.phone]);

  const filteredAccounts = useMemo(() => {
    const q = (searchTerm || '').toLowerCase().trim();
    return safeAccounts.filter(
      a =>
        Boolean(a) &&
        ((a.fullName || '').toLowerCase().includes(q) ||
        (a.email || '').toLowerCase().includes(q) ||
        String(a.phone || '').includes(searchTerm))
    );
  }, [safeAccounts, searchTerm]);

  const startEdit = (account: AdminAccount) => {
    // The row editor and the invite form carry the same fields, so only one of
    // them is ever on screen.
    setIsCreatingNew(false);
    setEditingId(account.id);
    setEditForm({
      fullName: account.fullName || '',
      email: account.email || '',
      phone: account.phone || '',
      role: account.role || 'admin',
    });
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    try {
      await updateAdminAccount(editingId, editForm);
      showAlert('Admin account updated', 'success');
      setEditingId(null);
    } catch {
      showAlert('Failed to update admin account', 'error');
    }
  };

  const handleDeleteAdmin = async (id: string) => {
    if (id === currentAdminAccountId) {
      showAlert('You cannot delete your own account', 'error');
      return;
    }
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      setTimeout(() => setConfirmDeleteId(null), 4000);
      return;
    }
    try {
      await deleteAdminAccount(id);
      showAlert('Admin account deleted', 'success');
    } catch {
      showAlert('Failed to delete admin account', 'error');
    } finally {
      setConfirmDeleteId(null);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profileForm.fullName.trim() || !profileForm.email.trim()) {
      showAlert('Name and email are required', 'error');
      return;
    }
    try {
      await updateAdminAccount(currentAdminAccountId, profileForm);
      showAlert('Profile updated successfully', 'success');
    } catch {
      showAlert('Failed to update profile', 'error');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordForm.next.length < 6) {
      showAlert('New password must be at least 6 characters', 'error');
      return;
    }
    if (passwordForm.next !== passwordForm.confirm) {
      showAlert('New passwords do not match', 'error');
      return;
    }
    try {
      await changeAdminPassword(passwordForm.current, passwordForm.next);
      setPasswordForm({ current: '', next: '', confirm: '' });
      setIsChangingPassword(false);
      showAlert('Password changed successfully', 'success');
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'Failed to change password', 'error');
    }
  };

  const handleCreateAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fullName = String(form.get('fullName') || '').trim();
    const email = String(form.get('email') || '').trim().toLowerCase();
    const phone = String(form.get('phone') || '').trim();
    const pin = String(form.get('pin') || '').trim();
    const role = String(form.get('role') || 'admin') as AdminAccount['role'];
    if (!fullName || !email || !phone || pin.length < 4) {
      showAlert('Name, email, phone, and a PIN of at least 4 characters are required', 'error');
      return;
    }
    if (safeAccounts.some(a => a?.email && a.email.toLowerCase() === email)) {
      showAlert('An admin account with this email already exists', 'error');
      return;
    }
    try {
      await addAdminAccount({ fullName, email, phone, role, pin });
    } catch {
      showAlert('Failed to create team member account', 'error');
      return;
    }
    setIsCreatingNew(false);
    showAlert(`Account created. Share the temporary PIN ${pin} securely with ${fullName}.`, 'success', { persistent: true });
  };

  return (
    <div className="space-y-6">

      {/* Header */}
      <AdminPageHeader
        description="Add team members, choose their access, and update your profile."
        action={
          // The create form opens with the same words as its own heading, so the
          // button steps out of the way while the form is on screen.
          isCreatingNew ? undefined : (
            <button
              onClick={() => { setEditingId(null); setIsCreatingNew(true); }}
              className="lux-btn lux-btn--primary"
            >
              <Plus className="w-4 h-4" />
              Add team member
            </button>
          )
        }
      />

      {/* Create Form */}
      {isCreatingNew && (
        <form
          onSubmit={handleCreateAccount}
          className="lux-card space-y-4 p-5"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="eyebrow">Access</p>
              <h2 className="brand-display mt-1 text-lg font-semibold text-[var(--text-primary)]">Add a team member</h2>
            </div>
            <button
              type="button"
              onClick={() => setIsCreatingNew(false)}
              className="rounded-full p-1.5 text-[var(--text-subtle)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-5">
            <div>
              <label htmlFor="new-fullName" className="lux-label">Full name</label>
              <input id="new-fullName" name="fullName" placeholder="Full name" required className="lux-input" />
            </div>
            <div>
              <label htmlFor="new-email" className="lux-label">Email</label>
              <input id="new-email" name="email" type="email" placeholder="Email address" required className="lux-input" />
            </div>
            <div>
              <label htmlFor="new-phone" className="lux-label">Phone</label>
              <input id="new-phone" name="phone" placeholder="Phone number" required className="lux-input" />
            </div>
            <div>
              <label htmlFor="new-pin" className="lux-label">Temporary PIN</label>
              <input id="new-pin" name="pin" type="password" inputMode="numeric" minLength={4} placeholder="Temporary PIN" required className="lux-input" />
            </div>
            <div>
              <label htmlFor="new-role" className="lux-label">Role</label>
              <select id="new-role" name="role" defaultValue="admin" className="lux-select">
                <option value="admin">Inventory Dispatcher</option>
                <option value="cashier">POS Cashier</option>
                <option value="manager">Manager</option>
                <option value="super_admin">Super Admin</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="lux-btn lux-btn--primary lux-btn--sm"
            >
              <Check className="h-4 w-4" />
              Create account
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingNew(false)}
              className="lux-btn lux-btn--outline lux-btn--sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 text-[var(--text-subtle)]" />
        <input
          type="text"
          placeholder="Search team members..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="lux-input pl-10"
        />
      </div>

      {/* Accounts Table */}
      <div className="lux-card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-color)] bg-[var(--bg-soft)] px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border-color)] bg-[var(--accent-soft)]">
              <Shield className="h-4 w-4 text-[var(--accent)]" />
            </span>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-subtle)]">Access directory</p>
              <p className="mt-0.5 text-sm font-semibold text-[var(--text-primary)]">{filteredAccounts.length} team member{filteredAccounts.length === 1 ? '' : 's'}</p>
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-sm sm:table-auto sm:min-w-[680px]">
            <thead className="border-b border-[var(--border-color)] bg-[var(--bg-soft)]">
              <tr>
                <th className="w-[48%] px-3 py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-subtle)] sm:w-auto sm:px-6">Name</th>
                <th className="hidden px-6 py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-subtle)] sm:table-cell">Email</th>
                <th className="hidden px-6 py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-subtle)] md:table-cell">Phone</th>
                <th className="w-[24%] px-2 py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-subtle)] sm:w-auto sm:px-6">Role</th>
                <th className="w-[28%] px-2 py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-subtle)] sm:w-auto sm:px-6">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]">
              {filteredAccounts.length > 0 ? (
                filteredAccounts.map(account => (
                  <tr key={account.id} className="transition-colors hover:bg-[var(--bg-soft)]">
                    {editingId === account.id ? (
                      <>
                        <td className="px-2 py-3 sm:px-6">
                          <div className="space-y-2">
                            <input
                              value={editForm.fullName}
                              onChange={e => setEditForm({ ...editForm, fullName: e.target.value })}
                              className="lux-input text-xs sm:text-sm"
                            />
                            <input
                              type="email"
                              value={editForm.email}
                              onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                              className="lux-input text-xs sm:hidden"
                              aria-label="Email"
                            />
                          </div>
                        </td>
                        <td className="hidden px-6 py-3 sm:table-cell">
                          <input
                            type="email"
                            value={editForm.email}
                            onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                            className="lux-input"
                          />
                        </td>
                        <td className="hidden px-6 py-3 md:table-cell">
                          <input
                            type="tel"
                            value={editForm.phone}
                            onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                            className="lux-input"
                          />
                        </td>
                        <td className="px-2 py-3 sm:px-6">
                          <select
                            value={editForm.role}
                            onChange={e => setEditForm({ ...editForm, role: e.target.value as AdminAccount['role'] })}
                            className="lux-select text-xs sm:text-sm"
                          >
                            <option value="manager">Manager</option>
                            <option value="admin">Admin</option>
                            <option value="cashier">POS Cashier</option>
                            <option value="super_admin">Super Admin</option>
                          </select>
                        </td>
                        <td className="px-2 py-3 sm:px-6">
                          <div className="flex items-center gap-1 sm:gap-2">
                            <button
                              onClick={handleSaveEdit}
                              className="rounded-xl bg-[var(--jade-soft)] p-2 text-[var(--jade)] transition-colors hover:bg-[color-mix(in_srgb,var(--jade)_22%,transparent)]"
                              title="Save changes"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="rounded-xl bg-[color-mix(in_srgb,var(--text-subtle)_14%,transparent)] p-2 text-[var(--text-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--text-subtle)_24%,transparent)] hover:text-[var(--text-primary)]"
                              title="Cancel"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-2 py-4 sm:px-6">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--border-color)] flex items-center justify-center font-bold text-xs flex-shrink-0 overflow-hidden">
                              {account.avatar ? (
                                <img src={account.avatar} alt="" className="h-full w-full object-cover" />
                              ) : (
                                String(account.fullName || '?').charAt(0).toUpperCase()
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="break-words text-xs font-semibold leading-tight text-[var(--text-primary)] sm:text-sm">
                                {account.fullName || 'Admin User'}
                              </p>
                              <p className="block max-w-full break-all text-[10px] leading-4 text-[var(--text-muted)] sm:hidden">
                                {account.email || '—'}
                              </p>
                              {account.id === currentAdminAccountId && (
                                <span className="text-[10px] font-bold text-[var(--accent)] uppercase tracking-wide">You</span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="hidden px-6 py-4 text-[var(--text-muted)] sm:table-cell">{account.email || '—'}</td>
                        <td className="hidden px-6 py-4 text-[var(--text-muted)] md:table-cell">{account.phone || '—'}</td>
                        <td className="px-2 py-4 sm:px-6">
                          <span className={`inline-flex max-w-full whitespace-normal break-words rounded-full px-1.5 py-1 text-center text-[10px] font-semibold leading-tight sm:px-2.5 sm:text-xs ${ROLE_BADGE[account.role || 'admin'] ?? 'bg-[color-mix(in_srgb,var(--text-subtle)_14%,transparent)] text-[var(--text-muted)]'}`}>
                            {ROLE_LABEL[account.role || 'admin'] ?? account.role ?? 'Admin'}
                          </span>
                        </td>
                        <td className="px-2 py-4 sm:px-6">
                          <div className="flex items-center gap-1 sm:gap-2">
                            <button
                              onClick={() => startEdit(account)}
                              className="rounded-xl bg-[var(--violet-soft)] p-2 text-[var(--violet)] transition-colors hover:bg-[color-mix(in_srgb,var(--violet)_22%,transparent)]"
                              title="Edit account"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            {/* Inline delete confirm */}
                            {confirmDeleteId === account.id ? (
                              <>
                                <button
                                  onClick={() => handleDeleteAdmin(account.id)}
                                  className="flex items-center gap-1 rounded-lg bg-[var(--danger)] px-2.5 py-1.5 text-xs font-bold text-[var(--danger-ink)] transition-opacity hover:opacity-90"
                                >
                                  <AlertTriangle className="w-3 h-3" />
                                  Confirm
                                </button>
                                <button
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="rounded-xl bg-[color-mix(in_srgb,var(--text-subtle)_14%,transparent)] p-2 text-[var(--text-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--text-subtle)_24%,transparent)] hover:text-[var(--text-primary)]"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => handleDeleteAdmin(account.id)}
                                disabled={account.id === currentAdminAccountId}
                                className="rounded-xl bg-[var(--danger-soft)] p-2 text-[var(--danger)] transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] disabled:opacity-40 disabled:cursor-not-allowed"
                                title={account.id === currentAdminAccountId ? 'Cannot delete your own account' : 'Delete account'}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <UserCheck className="w-8 h-8 text-[var(--text-subtle)] mx-auto mb-3" />
                    <p className="text-sm text-[var(--text-muted)]">No admin accounts found</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* My Profile Section */}
      <div className="lux-card p-6 space-y-5">
        <div className="flex items-center gap-4 pb-5 border-b border-[var(--border-color)]">
          <div className="w-14 h-14 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--border-color)] flex items-center justify-center text-2xl font-bold flex-shrink-0 overflow-hidden">
            {adminSession.avatar ? (
              <img src={adminSession.avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              (currentAdminProfile?.fullName || 'A').charAt(0).toUpperCase()
            )}
          </div>
          <div>
            <h2 className="brand-display text-xl font-semibold text-[var(--text-primary)]">My Profile</h2>
            <p className="mt-0.5 text-sm text-[var(--text-muted)]">
              {ROLE_LABEL[currentAdminProfile.role] ?? currentAdminProfile.role ?? 'Admin'} · {currentAdminProfile.email || 'No email set'}
            </p>
          </div>
        </div>

        {/* Change Password — above profile save for discoverability */}
        <div>
          <button
            type="button"
            onClick={() => setIsChangingPassword(v => !v)}
            className="lux-btn lux-btn--outline lux-btn--sm"
          >
            <Key className="w-4 h-4" />
            {isChangingPassword ? 'Cancel password change' : 'Change Password'}
          </button>

          {isChangingPassword && (
            <form
              onSubmit={handleChangePassword}
              className="mt-4 grid gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-soft)] p-4 sm:grid-cols-3"
            >
              <div>
                <label htmlFor="pw-current" className="lux-label">Current password</label>
                <input
                  id="pw-current"
                  type="password"
                  placeholder="Current password"
                  value={passwordForm.current}
                  onChange={e => setPasswordForm({ ...passwordForm, current: e.target.value })}
                  className="lux-input"
                />
              </div>
              <div>
                <label htmlFor="pw-next" className="lux-label">New password</label>
                <input
                  id="pw-next"
                  required
                  type="password"
                  placeholder="New password"
                  value={passwordForm.next}
                  onChange={e => setPasswordForm({ ...passwordForm, next: e.target.value })}
                  className="lux-input"
                />
              </div>
              <div>
                <label htmlFor="pw-confirm" className="lux-label">Confirm new password</label>
                <input
                  id="pw-confirm"
                  required
                  type="password"
                  placeholder="Confirm new password"
                  value={passwordForm.confirm}
                  onChange={e => setPasswordForm({ ...passwordForm, confirm: e.target.value })}
                  className="lux-input"
                />
              </div>
              <button
                type="submit"
                className="lux-btn lux-btn--primary lux-btn--sm sm:col-span-3 sm:justify-self-end"
              >
                <Key className="w-4 h-4" />
                Save password
              </button>
            </form>
          )}
        </div>

        {/* Profile form */}
        <form onSubmit={handleSaveProfile} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-fullName" className="lux-label">Full Name</label>
            <input
              id="profile-fullName"
              type="text"
              value={profileForm.fullName}
              onChange={e => setProfileForm({ ...profileForm, fullName: e.target.value })}
              className="lux-input"
            />
          </div>
          <div>
            <label htmlFor="profile-email" className="lux-label">Email</label>
            <input
              id="profile-email"
              type="email"
              value={profileForm.email}
              onChange={e => setProfileForm({ ...profileForm, email: e.target.value })}
              className="lux-input"
            />
          </div>
          <div>
            <label htmlFor="profile-phone" className="lux-label">Phone</label>
            <input
              id="profile-phone"
              type="tel"
              value={profileForm.phone}
              onChange={e => setProfileForm({ ...profileForm, phone: e.target.value })}
              className="lux-input"
            />
          </div>
          <div>
            <label htmlFor="profile-role" className="lux-label">Role</label>
            <input
              id="profile-role"
              type="text"
              value={ROLE_LABEL[currentAdminProfile.role] ?? currentAdminProfile.role}
              className="lux-input cursor-default"
              readOnly
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button
              type="submit"
              className="lux-btn lux-btn--primary"
            >
              <Check className="w-4 h-4" />
              Save Profile
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
