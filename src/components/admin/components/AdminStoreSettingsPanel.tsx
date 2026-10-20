import React, { useEffect, useState } from 'react';
import { Building2, Check, Upload } from 'lucide-react';
import { useStore } from '../../../context/StoreContext';
import { useAlert } from '../../../context/AlertContext';
import { api } from '../../../lib/api';
import type { StoreSettings } from '../../../types';

/**
 * Store settings: name, contact, TIN, logo.
 *
 * These values appear on every receipt and in the portal header. Only managers
 * may change them; cashiers see the current values but cannot edit.
 */
export function AdminStoreSettingsPanel(): React.ReactElement {
  const store = useStore();
  const { showAlert } = useAlert();
  const isManager = store.adminSession.adminRole === 'Super Admin' || store.adminSession.adminRole === 'Store Manager';

  const [draft, setDraft] = useState<StoreSettings>(store.storeSettings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(store.storeSettings);
  }, [store.storeSettings]);

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/pos-settings', { settings: draft });
      // Refresh the settings from the server so the receipt and header update
      // immediately without a full page reload.
      await store.fetchSettings();
      showAlert('Store settings saved.', 'success');
    } catch (error: any) {
      showAlert(error?.data?.error || error?.message || 'Could not save the settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setDraft(prev => ({ ...prev, logo: String(reader.result || '') }));
    };
    reader.readAsDataURL(file);
  };

  const field = (label: string, key: keyof StoreSettings, placeholder?: string, type = 'text') => (
    <label className="block">
      <span className="lux-label">{label}</span>
      <input
        type={type}
        className="lux-input"
        value={String(draft[key] || '')}
        disabled={!isManager}
        placeholder={placeholder}
        onChange={event => setDraft(prev => ({ ...prev, [key]: event.target.value }))}
      />
    </label>
  );

  return (
    <section className="lux-card space-y-4 p-5 md:p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
          <Building2 className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-bold text-[var(--text-primary)]">Store details</h2>
          <p className="mt-1 text-sm leading-5 text-[var(--text-muted)]">
            These values appear on receipts and in the portal header.
          </p>
        </div>
      </div>

      {!isManager && (
        <p className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-soft)] p-3 text-xs text-[var(--text-muted)]">
          Only the owner or a store manager can change these.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {field('Shop name', 'storeName', 'Anda C Smoke Hub')}
        {field('Telephone', 'storePhone', '0553346776')}
        {field('Email', 'storeEmail', 'hello@example.com', 'email')}
        {field('TIN', 'tin', 'Tax Identification Number')}
      </div>

      <label className="block">
        <span className="lux-label">Address</span>
        <textarea
          className="lux-input min-h-[60px] resize-y"
          value={draft.storeAddress || ''}
          disabled={!isManager}
          placeholder="Shop address"
          onChange={event => setDraft(prev => ({ ...prev, storeAddress: event.target.value }))}
        />
      </label>

      <div>
        <span className="lux-label">Logo</span>
        <div className="mt-1 flex items-center gap-3">
          {draft.logo && (
            <img src={draft.logo} alt="Store logo" className="h-12 w-12 rounded-lg border border-[var(--border-color)] object-contain" />
          )}
          <label className={`lux-btn lux-btn--outline lux-btn--sm inline-flex cursor-pointer items-center gap-2 ${!isManager ? 'pointer-events-none opacity-50' : ''}`}>
            <Upload className="h-4 w-4" />
            {draft.logo ? 'Change logo' : 'Upload logo'}
            <input type="file" accept="image/*" className="hidden" disabled={!isManager} onChange={handleLogoUpload} />
          </label>
          {draft.logo && isManager && (
            <button
              type="button"
              className="lux-btn lux-btn--ghost lux-btn--sm"
              onClick={() => setDraft(prev => ({ ...prev, logo: '' }))}
            >
              Remove
            </button>
          )}
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
          Shown at the top of every receipt. PNG or JPG, max 200 KB recommended.
        </p>
      </div>

      {isManager && (
        <div className="flex flex-wrap gap-2 pt-2">
          <button onClick={() => void save()} disabled={saving} className="lux-btn lux-btn--primary lux-btn--sm">
            <Check className="h-4 w-4" />
            {saving ? 'Saving…' : 'Save store details'}
          </button>
        </div>
      )}
    </section>
  );
}
