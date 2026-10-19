import React, { useState } from 'react';
import { Check, EyeOff, Layers, Plus, Save, Trash2 } from 'lucide-react';
import { useStore } from '../../../context/StoreContext';
import { useAlert } from '../../../context/AlertContext';
import type { CategoryConfig, CategoryType, DepartmentType } from '../../../types';
import { AdminMetricCard, AdminPageHeader, AdminStatusBadge } from '../components/AdminPrimitives';

const inputClass = 'lux-input';

const defaultCreateForm = {
  id: '',
  slug: '',
  name: '',
  department: 'beauty' as DepartmentType,
  isActive: true,
};

export const AdminPOSCatalogScreen: React.FC = () => {
  const store = useStore();
  const { showAlert } = useAlert();
  const [editing, setEditing] = useState<CategoryConfig | null>(null);
  const [form, setForm] = useState({ name: '', department: 'beauty' as DepartmentType });
  const [createForm, setCreateForm] = useState(defaultCreateForm);

  const beginEdit = (category: CategoryConfig) => {
    setEditing(category);
    setForm({ name: category.name, department: category.department });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || !form.name.trim()) return;
    await store.updateCategory(editing.id, {
      name: form.name.trim(),
      department: form.department,
    });
    showAlert('Category updated', 'success');
    setEditing(null);
  };

  const createCategory = async (event: React.FormEvent) => {
    event.preventDefault();
    const id = createForm.id.trim();
    const name = createForm.name.trim();
    const slug = createForm.slug.trim();
    if (!id || !name || !slug) {
      showAlert('Category ID, name, and slug are required.', 'error');
      return;
    }
    const category: CategoryConfig = {
      id: id as CategoryType,
      slug: slug.toLowerCase().replace(/\s+/g, '-'),
      name,
      description: '',
      department: createForm.department,
      image: '',
      isActive: createForm.isActive,
    };
    await store.addCategory(category);
    showAlert(`Category “${name}” added.`, 'success');
    setCreateForm(defaultCreateForm);
  };

  const removeCategory = async (category: CategoryConfig) => {
    if (!window.confirm(`Remove “${category.name}”? Products assigned to it may need a new category.`)) return;
    await store.deleteCategory(category.id);
    showAlert(`Category “${category.name}” removed.`, 'success');
    if (editing?.id === category.id) setEditing(null);
  };

  const toggle = async (category: CategoryConfig) => {
    await store.toggleCategory(category.id);
    showAlert(`${category.name} ${category.isActive ? 'deactivated' : 'activated'}.`, 'success');
  };

  const activeCount = store.categories.filter(category => category.isActive).length;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Organize products for the register and stockroom."
        action={<span className="lux-chip lux-chip--neutral">{activeCount} active</span>}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <AdminMetricCard label="Total" value={store.categories.length} detail="Catalog categories" icon={Layers} accent="neutral" />
        <AdminMetricCard label="Active" value={activeCount} detail="Available for products" icon={Check} accent="green" />
        <AdminMetricCard label="Inactive" value={store.categories.length - activeCount} detail="Hidden from selection" icon={EyeOff} accent="amber" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-3">
          {store.categories.map(category => (
            <div key={category.id} className="lux-card flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-bold text-[var(--text-primary)]">{category.name}</p>
                <p className="text-xs text-[var(--text-muted)]">{category.department} · /{category.slug}</p>
              </div>
              <AdminStatusBadge label={category.isActive ? 'Active' : 'Inactive'} tone={category.isActive ? 'success' : 'neutral'} />
              <button className="lux-btn lux-btn--outline lux-btn--sm" onClick={() => beginEdit(category)}>Edit</button>
              <button className="lux-btn lux-btn--outline lux-btn--sm" onClick={() => void toggle(category)}>{category.isActive ? 'Deactivate' : 'Activate'}</button>
              <button className="lux-btn lux-btn--danger lux-btn--sm" onClick={() => void removeCategory(category)} aria-label={`Delete ${category.name}`}><Trash2 className="mr-1 inline h-3.5 w-3.5" />Remove</button>
            </div>
          ))}
        </div>
        <div className="space-y-5">
          {/* One panel, one purpose: it offers the new-category fields until a
              row's Edit is picked, then it becomes that category's editor. */}
          {editing ? (
            <form onSubmit={event => void save(event)} className="lux-card h-fit space-y-4 p-5">
              <h2 className="font-bold text-[var(--text-primary)]">Edit {editing.name}</h2>
              <label className="block"><span className="lux-label">Name</span><input className={inputClass} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
              <label className="block"><span className="lux-label">Department</span><select className={inputClass} value={form.department} onChange={event => setForm({ ...form, department: event.target.value as DepartmentType })}><option value="beauty">Shisha &amp; hookah</option><option value="groceries">Lounge supplies</option></select></label>
              <div className="flex gap-2"><button className="lux-btn lux-btn--primary flex-1"><Save className="h-4 w-4" />Save changes</button><button type="button" className="lux-btn lux-btn--outline" onClick={() => setEditing(null)}>Cancel</button></div>
            </form>
          ) : (
            <form onSubmit={event => void createCategory(event)} className="lux-card h-fit space-y-4 p-5">
              <h2 className="font-bold text-[var(--text-primary)]">New category</h2>
              <label className="block"><span className="lux-label">ID</span><input className={inputClass} placeholder="e.g. shisha-flavors" value={createForm.id} onChange={event => setCreateForm({ ...createForm, id: event.target.value })} /></label>
              <label className="block"><span className="lux-label">Name</span><input className={inputClass} placeholder="Category name" value={createForm.name} onChange={event => setCreateForm({ ...createForm, name: event.target.value })} /></label>
              <label className="block"><span className="lux-label">Slug</span><input className={inputClass} placeholder="category-slug" value={createForm.slug} onChange={event => setCreateForm({ ...createForm, slug: event.target.value })} /></label>
              <label className="block"><span className="lux-label">Department</span><select className={inputClass} value={createForm.department} onChange={event => setCreateForm({ ...createForm, department: event.target.value as DepartmentType })}><option value="beauty">Shisha &amp; hookah</option><option value="groceries">Lounge supplies</option></select></label>
              <button className="lux-btn lux-btn--primary w-full"><Plus className="h-4 w-4" />Add category</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};