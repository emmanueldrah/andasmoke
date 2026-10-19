import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  Product,
  CategoryConfig,
  PromoCode,
  StoreSettings,
  StoreSettingsRow,
  AdminSession,
  Order,
  CategoryType,
  AdminAccount,
} from '../types';
import { api } from '../lib/api';
import { CATEGORIES_CONFIG, BRANDS_LIST } from '../data/products';
import { isRenderableProductImage, productImageUrls } from '../lib/productImages';
import { BUSINESS_PHONE, resolveStorePhone } from '../lib/storeContact';
import {
  DEFAULT_HARDWARE_SETTINGS,
  normalizeHardwareSettings,
  type HardwareSettings,
} from '../lib/hardware';

interface StoreContextType {
  products: Product[];
  loading: boolean;
  error: string | null;
  fetchProducts: (params?: { category?: string; department?: string; published?: boolean; includeUnpublished?: boolean }) => Promise<void>;
  addProduct: (product: Omit<Product, 'id'>) => Promise<Product>;
  updateProduct: (id: string, updates: Partial<Product>) => Promise<void>;
  deleteProduct: (id: string) => Promise<void>;
  updateProductStock: (id: string, stockCount: number, inStock?: boolean) => Promise<void>;

  brands: string[];
  loadingBrands: boolean;
  fetchBrands: () => Promise<void>;
  addBrand: (brand: string) => Promise<void>;
  deleteBrand: (brand: string) => Promise<void>;

  categories: CategoryConfig[];
  loadingCategories: boolean;
  fetchCategories: () => Promise<void>;
  updateCategory: (id: CategoryType, updates: Partial<CategoryConfig>) => Promise<void>;
  addCategory: (category: CategoryConfig) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  toggleCategory: (id: CategoryType) => Promise<void>;

  orders: Order[];
  loadingOrders: boolean;
  fetchOrders: () => Promise<void>;

  promoCodes: PromoCode[];
  loadingPromos: boolean;
  fetchPromoCodes: () => Promise<void>;
  addPromoCode: (promo: Omit<PromoCode, 'id' | 'usageCount'>) => Promise<void>;
  togglePromoCode: (code: string) => Promise<void>;
  deletePromoCode: (id: string) => Promise<void>;
  validatePromoCode: (code: string, subtotal: number) => Promise<{
    valid: boolean;
    discountAmount: number;
    message: string;
    promo?: PromoCode;
  }>;

  storeSettings: StoreSettings;
  fetchSettings: () => Promise<void>;

  /** Scanner timing and label size for this till. */
  hardwareSettings: HardwareSettings;
  fetchHardwareSettings: () => Promise<void>;
  saveHardwareSettings: (next: HardwareSettings) => Promise<void>;

  adminSession: AdminSession;
  adminAccounts: AdminAccount[];
  loadingAdmin: boolean;
  loginAdmin: (pin: string, email: string, role?: AdminSession['adminRole'], name?: string) => Promise<boolean>;
  logoutAdmin: () => Promise<void>;
  fetchAdminAccounts: () => Promise<void>;
  syncProfileFromCloud: () => Promise<boolean>;
  addAdminAccount: (account: Omit<AdminAccount, 'id'> & { pin?: string }) => Promise<AdminAccount>;
  updateAdminAccount: (id: string, updates: Partial<AdminAccount>) => Promise<void>;
  deleteAdminAccount: (id: string) => Promise<void>;
  changeAdminPassword: (currentPin: string, newPin: string) => Promise<void>;
}

export const SHOP_NAME = 'Anda C Smoke Hub';

const DEFAULT_STORE_SETTINGS: StoreSettings = {
  storeName: SHOP_NAME,
  storePhone: BUSINESS_PHONE,
  storeEmail: '',
  storeAddress: 'Nmai Dzorn Adjiringano Road, Accra, Ghana',
};

const normalizeStoreSettings = (settings: Partial<StoreSettings>): Partial<StoreSettings> => {
  const savedStoreName = settings.storeName?.trim();
  // Names from earlier revisions of this shop, replaced on sight.
  const legacyNames = ['anda c smoke hub', 'shisha soul', 'soul smoke lounge', 'pos system', 'retail pos'];
  return {
    storeName: !savedStoreName || legacyNames.includes(savedStoreName.toLowerCase())
      ? SHOP_NAME
      : savedStoreName,
    storeEmail: settings.storeEmail?.trim() || '',
    storePhone: resolveStorePhone(settings.storePhone),
    storeAddress: settings.storeAddress?.trim() || DEFAULT_STORE_SETTINGS.storeAddress,
  };
};

/**
 * Staff accounts live in the local database. Nothing is pre-seeded here: the
 * first run shows a setup screen that creates the single super admin, after
 * which this list is populated from the API.
 */
const INITIAL_ADMIN_ACCOUNTS: AdminAccount[] = [];

const normalizeProduct = (product: Product): Product => {
  const normalizedVariants = (product.variants || []).map(variant => ({
    ...variant,
    price: Number(variant.price),
  }));
  const variantStockTotal = normalizedVariants.reduce((total, variant) => total + Math.max(0, Number(variant.stockCount ?? 0) || 0), 0);
  const hasVariants = normalizedVariants.length > 0;
  return {
  ...product,
  // Existing records remain visible during the server-side migration. New media
  // is accepted only through the local media upload endpoint.
  image: isRenderableProductImage(product.image) ? product.image : '',
  images: productImageUrls(product.images || [product.image]),
  price: Number(product.price),
  stockCount: hasVariants ? variantStockTotal : Number(product.stockCount || 0),
  variants: normalizedVariants,
};
};

const normalizePosCategories = (categories: CategoryConfig[]): CategoryConfig[] => {
  const labels: Partial<Record<CategoryType, { name: string; slug: string; description: string }>> = {
    skincare: { name: 'Shisha Flavors', slug: 'shisha-flavors', description: 'Shisha flavor inventory' },
    makeup: { name: 'Hookahs & Pipes', slug: 'hookahs', description: 'Hookahs and pipes' },
    fragrances: { name: 'Coals & Heat', slug: 'coals', description: 'Charcoal and heat management' },
    'body-care': { name: 'Accessories', slug: 'accessories', description: 'Hookah accessories' },
    'beauty-tools': { name: 'Parts & Cleaning', slug: 'parts-cleaning', description: 'Replacement parts and cleaning supplies' },
    beverages: { name: 'Drinks & Refreshments', slug: 'drinks', description: 'Lounge drinks and refreshments' },
    'daily-essentials': { name: 'Lounge Supplies', slug: 'lounge-supplies', description: 'Consumables for lounge service' },
  };
  const removedCategories = new Set<CategoryType>(['rice-grains', 'cooking-oils', 'seasoning-spices', 'household-care']);
  return categories
    .filter(category => !removedCategories.has(category.id))
    .map(category => ({ ...category, ...(labels[category.id] || {}) }));
};

const INITIAL_SEED_ORDERS: Order[] = [];

const INITIAL_SEED_PROMOS: PromoCode[] = [];

const StoreContext = createContext<StoreContextType | undefined>(undefined);

export const StoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  /**
   * Scanner timing and label size.
   *
   * Loaded from the database so the till's hardware behaviour is the same on
   * every machine it is restored onto, and so it can be tuned for a slow scanner
   * without a rebuild.
   */
  const [hardwareSettings, setHardwareSettings] = useState<HardwareSettings>(DEFAULT_HARDWARE_SETTINGS);

  /** Loads the till's hardware settings. Safe to call before anyone signs in. */
  const fetchHardwareSettings = useCallback(async () => {
    try {
      const result = await api.get<HardwareSettings>('/settings?resource=hardware');
      if (result) setHardwareSettings(normalizeHardwareSettings(result));
    } catch {
      // Defaults already applied; the till works without this.
    }
  }, []);

  /** Saves new hardware settings. Managers only; the server rejects others. */
  const saveHardwareSettings = useCallback(async (next: HardwareSettings) => {
    const cleaned = normalizeHardwareSettings(next);
    const result = await api.put<HardwareSettings>('/settings?resource=hardware', cleaned);
    setHardwareSettings(normalizeHardwareSettings(result ?? cleaned));
  }, []);

  /** Set once someone has signed in on this device. */
  const hasSession = useCallback(
    () => Boolean(localStorage.getItem('anda_auth_token') || localStorage.getItem('auth_token')),
    [],
  );

  // Load once signed in, and again after a sign-out/sign-in cycle, so a till
  // restored from a backup picks up the new hardware settings.
  useEffect(() => {
    const load = () => { if (hasSession()) void fetchHardwareSettings(); };
    load();
    window.addEventListener('anda-auth-changed', load);
    return () => window.removeEventListener('anda-auth-changed', load);
  }, [fetchHardwareSettings, hasSession]);

  // Load initial state with local storage fallback for 100% consistency
  const [products, setProducts] = useState<Product[]>(() => {
    try {
      const saved = localStorage.getItem('anda_products');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map(normalizeProduct);
        }
      }
    } catch {}
    return [];
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [brands, setBrands] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('anda_brands');
      if (saved) {
        const parsed = JSON.parse(saved) as Array<string | { name?: string }>;
        return parsed
          .map(brand => typeof brand === 'string' ? brand : brand.name || '')
          .filter(Boolean);
      }
    } catch { return BRANDS_LIST; }
    return BRANDS_LIST;
  });
  const [loadingBrands, setLoadingBrands] = useState(false);

  const [categories, setCategories] = useState<CategoryConfig[]>(() => {
    try {
      const saved = localStorage.getItem('anda_categories');
      if (saved) return normalizePosCategories(JSON.parse(saved));
    } catch { return CATEGORIES_CONFIG; }
    return CATEGORIES_CONFIG;
  });
  const [loadingCategories, setLoadingCategories] = useState(false);

  const [orders, setOrders] = useState<Order[]>(() => {
    try {
      const saved = localStorage.getItem('anda_orders');
      if (saved) return JSON.parse(saved);
    } catch { return INITIAL_SEED_ORDERS; }
    return INITIAL_SEED_ORDERS;
  });
  const [loadingOrders, setLoadingOrders] = useState(false);

  const [promoCodes, setPromoCodes] = useState<PromoCode[]>(() => {
    try {
      const saved = localStorage.getItem('anda_promos');
      if (saved) return JSON.parse(saved);
    } catch { return INITIAL_SEED_PROMOS; }
    return INITIAL_SEED_PROMOS;
  });
  const [loadingPromos, setLoadingPromos] = useState(false);

  const [storeSettings, setStoreSettings] = useState<StoreSettings>(() => {
    try {
      const saved = localStorage.getItem('anda_settings');
      return saved ? { ...DEFAULT_STORE_SETTINGS, ...normalizeStoreSettings(JSON.parse(saved)) } : DEFAULT_STORE_SETTINGS;
    } catch {
      return DEFAULT_STORE_SETTINGS;
    }
  });
  const [adminSession, setAdminSession] = useState<AdminSession>(() => {
    try {
      const saved = localStorage.getItem('anda_admin_session');
      // Only a verified admin token may restore the register session.
      if (saved && localStorage.getItem('anda_auth_token')) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.isLoggedIn) {
          const avatars = JSON.parse(localStorage.getItem('anda_admin_avatars') || '{}');
          const emailKey = (parsed.email || '').toLowerCase().trim();
          const avatar = parsed.avatar || (emailKey ? avatars[emailKey] : undefined) || (parsed.adminId ? avatars[parsed.adminId] : undefined);
          return { ...parsed, avatar };
        }
      }
    } catch {}
    return {
      isLoggedIn: false,
      adminName: '',
      adminRole: 'Super Admin',
      email: '',
    };
  });
  const [loadingAdmin, setLoadingAdmin] = useState(false);
  const [adminAccounts, setAdminAccounts] = useState<AdminAccount[]>(() => {
    try {
      const saved = localStorage.getItem('anda_admin_accounts');
      if (saved) return JSON.parse(saved);
    } catch { return INITIAL_ADMIN_ACCOUNTS; }
    return INITIAL_ADMIN_ACCOUNTS;
  });

  const persistCache = (key: string, value: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Browser cache is optional. Never allow a quota error to take down the
      // POS portal; live data remains available from the API.
      console.warn(`Could not cache ${key} locally.`, error);
    }
  };

  // Sync small, non-critical caches only. Products deliberately stay out of localStorage.
  useEffect(() => {
    try { localStorage.removeItem('anda_products'); } catch {}
  }, []);

  useEffect(() => {
    persistCache('anda_orders', orders);
  }, [orders]);

  useEffect(() => {
    persistCache('anda_promos', promoCodes);
  }, [promoCodes]);

  useEffect(() => {
    persistCache('anda_categories', categories);
  }, [categories]);

  useEffect(() => {
    persistCache('anda_admin_accounts', adminAccounts);
  }, [adminAccounts]);

  useEffect(() => {
    persistCache('anda_settings', storeSettings);
  }, [storeSettings]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== 'anda_settings' || !event.newValue) return;
      try {
        setStoreSettings(previous => ({ ...previous, ...normalizeStoreSettings(JSON.parse(event.newValue!)) }));
      } catch {
        // Ignore malformed cross-tab storage values.
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const fetchProducts = useCallback(async (params?: { category?: string; department?: string; published?: boolean; includeUnpublished?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (params?.category) query.set('category', params.category);
      if (params?.department) query.set('department', params.department);
      if (params?.published !== undefined) query.set('published', params.published.toString());
      const shouldIncludeUnpublished = params?.includeUnpublished
        || (params?.published === undefined && Boolean(localStorage.getItem('anda_auth_token')));
      if (shouldIncludeUnpublished) query.set('includeUnpublished', 'true');
      query.set('limit', '500');
      const data = await api.get<{ products: Product[] }>(`/products?${query}`, shouldIncludeUnpublished ? undefined : null);
      if (data && Array.isArray(data.products)) {
        setProducts(data.products.map(normalizeProduct));
        return;
      }
      setProducts([]);
    } catch (e: any) {
      setProducts([]);
      setError('Failed to load products from server.');
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchBrands = useCallback(async () => {
    setLoadingBrands(true);
    try {
      const data = await api.get<Array<string | { name: string }>>('/catalog?resource=brands');
      if (data && Array.isArray(data) && data.length > 0) {
        setBrands(data.map(brand => typeof brand === 'string' ? brand : brand.name));
      }
    } catch (e: any) {
      setError('Failed to load brands from server.');
      throw e;
    } finally {
      setLoadingBrands(false);
    }
  }, []);

  const fetchCategories = useCallback(async () => {
    setLoadingCategories(true);
    try {
      const data = await api.get<CategoryConfig[]>('/catalog?resource=categories');
      if (data && Array.isArray(data) && data.length > 0) {
        setCategories(normalizePosCategories(data));
      }
    } catch (e: any) {
      setError('Failed to load categories from server.');
      throw e;
    } finally {
      setLoadingCategories(false);
    }
  }, []);

  const fetchOrders = useCallback(async () => {
    if (!localStorage.getItem('auth_token') && !localStorage.getItem('anda_auth_token')) {
      return;
    }
    setLoadingOrders(true);
    try {
      const query = new URLSearchParams();
      const data = await api.get<{ orders: Order[] }>(`/orders?${query}`);
      if (data && Array.isArray(data.orders)) setOrders(data.orders);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) {
        return;
      }
      setError('Failed to load orders from server.');
      throw e;
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  const fetchPromoCodes = useCallback(async () => {
    setLoadingPromos(true);
    try {
      const data = await api.get<PromoCode[]>('/promo-codes');
      if (data && Array.isArray(data) && data.length > 0) {
        setPromoCodes(data);
      }
    } catch (e: any) {
      setError('Failed to load promo codes from server.');
      throw e;
    } finally {
      setLoadingPromos(false);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await api.get<StoreSettingsRow[]>('/settings');
      if (data && Array.isArray(data) && data.length > 0) {
        const settings = data.reduce((acc, s) => {
          let value = s.value;
          if (typeof value === 'string') {
            try {
              value = JSON.parse(value);
            } catch {
              // Keep as string if not valid JSON
            }
          }
          return { ...acc, [s.key]: value };
        }, {} as StoreSettings);
        
        setStoreSettings(prev => ({ ...prev, ...normalizeStoreSettings(settings) }));
      }
    } catch (e: any) {
      setError('Failed to load POS receipt settings from server.');
      throw e;
    }
  }, []);

  // Initial load
  useEffect(() => {
    if (!localStorage.getItem('anda_auth_token')) return;
    const startupRequests: Array<Promise<unknown>> = [
      fetchProducts({ includeUnpublished: true }),
      fetchCategories(),
      fetchSettings(),
      fetchPromoCodes(),
    ];
    startupRequests.push(fetchBrands());
    void Promise.allSettled(startupRequests);
  }, [fetchProducts, fetchBrands, fetchCategories, fetchSettings, fetchPromoCodes]);

  // Verify the saved admin token before restoring the register session.
  useEffect(() => {
    const adminToken = localStorage.getItem('anda_auth_token');
    if (!adminToken) {
      localStorage.removeItem('anda_admin_session');
      return;
    }

    let cancelled = false;
    void api.get<{ role: 'admin'; email: string; adminName?: string; adminRole?: string; avatar?: string }>('/auth?action=session', adminToken)
      .then(session => {
        // Do not let an older validation request overwrite a newer login.
        if (cancelled || localStorage.getItem('anda_auth_token') !== adminToken) return;
        const avatars = JSON.parse(localStorage.getItem('anda_admin_avatars') || '{}');
        const emailKey = (session.email || '').toLowerCase().trim();
        const existingSession = JSON.parse(localStorage.getItem('anda_admin_session') || '{}');
        const restored: AdminSession = {
          isLoggedIn: true,
          adminId: (session as any).adminId || existingSession.adminId,
          adminName: session.adminName || '',
          adminRole: (session.adminRole || 'Super Admin') as AdminSession['adminRole'],
          email: session.email,
          phone: (session as any).phone || existingSession.phone,
          avatar: session.avatar !== undefined
            ? session.avatar || undefined
            : existingSession.avatar || (emailKey ? avatars[emailKey] : undefined),
        };
        localStorage.setItem('anda_admin_session', JSON.stringify(restored));
        setAdminSession(restored);
      })
      .catch(() => {
        // The user may have successfully signed in while this older request
        // was in flight. Only clear the exact token that was validated.
        if (cancelled || localStorage.getItem('anda_auth_token') !== adminToken) return;
        localStorage.removeItem('anda_auth_token');
        localStorage.removeItem('anda_admin_session');
        setAdminSession({ isLoggedIn: false, adminName: '', adminRole: 'Super Admin', email: '' });
      });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handleExpiredAdminSession = (event: Event) => {
      const tokenKey = (event as CustomEvent<{ tokenKey?: string }>).detail?.tokenKey;
      if (tokenKey !== 'anda_auth_token') return;
      setAdminSession({ isLoggedIn: false, adminName: '', adminRole: 'Super Admin', email: '' });
    };
    window.addEventListener('anda-auth-expired', handleExpiredAdminSession);
    return () => window.removeEventListener('anda-auth-expired', handleExpiredAdminSession);
  }, []);


  // Product Actions
  const addProduct = async (productData: Omit<Product, 'id'>): Promise<Product> => {
    const newId = 'prod-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
    try {
      const adminToken = localStorage.getItem('anda_auth_token');
      if (!adminToken) throw new Error('Administrator session required. Please sign in again.');
      const apiResult = await api.post<Product>('/products', { ...productData, id: newId }, adminToken);
      const normalized = normalizeProduct(apiResult);
      setProducts(prev => [normalized, ...prev.filter(p => p.id !== normalized.id)]);
      if (productData.brand && !brands.includes(productData.brand)) {
        setBrands(prev => [...prev, productData.brand]);
      }
      await fetchProducts({ includeUnpublished: true });
      return normalized;
    } catch (e: any) {
      const errorMsg = e?.data?.error || e?.message || 'Failed to add product to server.';
      setError(errorMsg);
      console.error('Failed to add product to server:', e);
      throw e;
    }
  };

  const updateProduct = async (id: string, updates: Partial<Product>) => {
    try {
      const adminToken = localStorage.getItem('anda_auth_token');
      if (!adminToken) throw new Error('Administrator session required. Please sign in again.');
      const updated = await api.patch<Product>(`/products?id=${encodeURIComponent(id)}`, updates, adminToken);
      const normalized = normalizeProduct(updated);
      setProducts(prev => prev.map(p => p.id === id ? { ...p, ...normalized } : p));
      await fetchProducts({ includeUnpublished: true });
    } catch (e: any) {
      const errorMsg = e?.data?.error || e?.message || 'Failed to update product on server.';
      setError(errorMsg);
      console.error('Failed to update product on server:', e);
      throw e;
    }
  };

  const deleteProduct = async (id: string) => {
    try {
      const adminToken = localStorage.getItem('anda_auth_token');
      if (!adminToken) throw new Error('Administrator session required. Please sign in again.');
      await api.delete(`/products?id=${encodeURIComponent(id)}`, adminToken);
      setProducts(prev => prev.filter(p => p.id !== id));
      await fetchProducts({ includeUnpublished: true });
    } catch (e: any) {
      const errorMsg = e?.data?.error || e?.message || 'Failed to delete product from server.';
      setError(errorMsg);
      console.error('Failed to delete product from server:', e);
      throw e;
    }
  };

  const updateProductStock = async (id: string, stockCount: number, inStock?: boolean) => {
    const available = inStock !== undefined ? inStock && stockCount > 0 : stockCount > 0;
    await updateProduct(id, { stockCount, inStock: available, ...(available ? {} : { isPublished: false }) });
  };

  // Brand Actions
  const addBrand = async (brand: string) => {
    const trimmed = brand.trim();
    if (trimmed && !brands.includes(trimmed)) {
      setBrands(prev => [...prev, trimmed]);
      try {
        await api.post('/catalog?resource=brands', { name: trimmed });
        await fetchBrands();
      } catch (e: any) { setError(e.message || "Operation failed"); }
    }
  };

  const deleteBrand = async (brand: string) => {
    setBrands(prev => prev.filter(b => b !== brand));
    try {
      await api.delete(`/catalog?resource=brands&id=${encodeURIComponent(brand)}`);
      await fetchBrands();
    } catch (e: any) { setError(e.message || "Operation failed"); }
  };

  // Category Actions
  const updateCategory = async (id: CategoryType, updates: Partial<CategoryConfig>) => {
    setCategories(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
    try {
      await api.patch<CategoryConfig>(`/catalog?resource=categories&id=${encodeURIComponent(id)}`, updates);
      await fetchCategories();
    } catch (e: any) { setError(e.message || "Operation failed"); }
  };

  const addCategory = async (category: CategoryConfig) => {
    setCategories(prev => [...prev, category]);
    try {
      await api.post<CategoryConfig>('/catalog?resource=categories', category);
      await fetchCategories();
    } catch (e: any) { setError(e.message || "Operation failed"); }
  };

  const deleteCategory = async (id: string) => {
    setCategories(prev => prev.filter(c => c.id !== id));
    try {
      await api.delete(`/catalog?resource=categories&id=${encodeURIComponent(id)}`);
      await fetchCategories();
    } catch (e: any) { setError(e.message || "Operation failed"); }
  };

  const toggleCategory = async (id: CategoryType) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return;
    updateCategory(id, { isActive: !cat.isActive });
  };

  // Promo Actions
  const addPromoCode = async (promoData: Omit<PromoCode, 'id' | 'usageCount'>) => {
    const newPromo: PromoCode = {
      ...promoData,
      id: 'promo-' + Date.now(),
      usageCount: 0,
    };
    setPromoCodes(prev => [newPromo, ...prev]);
    try {
      await api.post('/promo-codes', promoData);
    } catch (e: any) { setError(e.message || "Operation failed"); }
  };

  const togglePromoCode = async (code: string) => {
    const target = promoCodes.find(p => p.code === code);
    const nextActive = !(target?.isActive ?? true);
    setPromoCodes(prev => prev.map(p => p.code === code ? { ...p, isActive: nextActive } : p));
    try {
      if (!target?.id) throw new Error('Promo code not found');
      await api.patch(`/promo-codes?id=${encodeURIComponent(target.id)}`, { isActive: nextActive });
    } catch (e: any) { setError(e.message || "Operation failed"); }
  };

  const deletePromoCode = async (id: string) => {
    setPromoCodes(prev => prev.filter(p => p.id !== id));
    try {
      await api.delete(`/promo-codes?id=${encodeURIComponent(id)}`);
    } catch (e: any) { setError(e.message || "Operation failed"); }
  };

  const validatePromoCode = async (code: string, subtotal: number) => {
    const cleanCode = code.trim().toUpperCase();
    const promo = promoCodes.find(p => p.code.toUpperCase() === cleanCode && p.isActive);

    if (!promo) {
      return { valid: false, discountAmount: 0, message: 'Invalid or expired promo code' };
    }

    if (promo.minSpend && subtotal < promo.minSpend) {
      return {
        valid: false,
        discountAmount: 0,
        message: `Minimum spend of GHS ${promo.minSpend} required for this code (Your cart: GHS ${subtotal.toFixed(2)})`
      };
    }

    let discountAmount = 0;
    if (promo.discountType === 'percentage') {
      discountAmount = (subtotal * promo.discountValue) / 100;
    } else if (promo.discountType === 'fixed') {
      discountAmount = Math.min(promo.discountValue, subtotal);
    }

    return {
      valid: true,
      discountAmount,
      message: `Code ${cleanCode} applied successfully!`,
      promo,
    };
  };

  // Admin Auth Actions
  /**
   * Staff sign-in. The local API holds every account, so there is no offline
   * fallback: without a valid PIN the sign-in simply fails.
   */
  const loginAdmin = async (pin: string, email: string, role: AdminSession['adminRole'] = 'Super Admin', name = ''): Promise<boolean> => {
    const cleanEmail = email.trim().toLowerCase();
    const cleanPin = pin.trim();
    if (!cleanEmail || !cleanPin) {
      setLoadingAdmin(false);
      return false;
    }
    setLoadingAdmin(true);

    try {
      const result = await api.post<{ token: string; cloudToken?: string; admin: { id: string; adminName: string; adminRole: string; email: string; avatar?: string } }>('/auth?action=admin', {
        email: cleanEmail,
        pin: cleanPin,
        name,
        role,
      });

      if (!result?.admin) throw new Error('Sign-in was rejected');

      const avatars = JSON.parse(localStorage.getItem('anda_admin_avatars') || '{}');
      const emailKey = (result.admin.email || '').toLowerCase().trim();
      const avatar = result.admin.avatar !== undefined
        ? result.admin.avatar || undefined
        : (emailKey ? avatars[emailKey] : undefined) || (result.admin.id ? avatars[result.admin.id] : undefined);

const sessionPayload: AdminSession = {
        isLoggedIn: true,
        adminId: result.admin.id,
        adminName: result.admin.adminName,
        adminRole: result.admin.adminRole as AdminSession['adminRole'],
        email: result.admin.email,
        avatar,
      };

localStorage.setItem('anda_auth_token', result.token);
      if (result.cloudToken) {
        localStorage.setItem('anda_cloud_auth_token', result.cloudToken);
        localStorage.setItem('anda_cloud_auth_email', cleanEmail);
      } else if (localStorage.getItem('anda_cloud_auth_email') !== cleanEmail) {
        localStorage.removeItem('anda_cloud_auth_token');
        localStorage.removeItem('anda_cloud_auth_email');
      }
      localStorage.setItem('anda_admin_session', JSON.stringify(sessionPayload));
      setAdminSession(sessionPayload);

      await Promise.allSettled([
        fetchProducts({ includeUnpublished: true }),
        fetchBrands(),
        fetchCategories(),
        fetchOrders(),
        fetchSettings(),
        fetchPromoCodes(),
        // Scans and labels can change per till, so pick up the current values
        // rather than the ones cached before sign-in.
        fetchHardwareSettings(),
      ]);
      setLoadingAdmin(false);
      return true;
    } catch {
      localStorage.removeItem('anda_auth_token');
      localStorage.removeItem('anda_admin_session');
      localStorage.removeItem('anda_cloud_auth_token');
      localStorage.removeItem('anda_cloud_auth_email');
      setAdminSession(prev => ({ ...prev, isLoggedIn: false }));
      setLoadingAdmin(false);
      return false;
    }
  };

  const logoutAdmin = async () => {
    localStorage.removeItem('anda_auth_token');
    localStorage.removeItem('anda_admin_session');
    localStorage.removeItem('anda_cloud_auth_token');
    localStorage.removeItem('anda_cloud_auth_email');
    setAdminSession({
      isLoggedIn: false,
      adminName: '',
      adminRole: 'Super Admin',
      email: '',
    });
  };

  const fetchAdminAccounts = useCallback(async () => {
    try {
      const accounts = await api.get<AdminAccount[]>('/admin-accounts');
      if (Array.isArray(accounts)) {
        const avatars = JSON.parse(localStorage.getItem('anda_admin_avatars') || '{}');
        const enriched = accounts.map(acc => ({ ...acc, avatar: acc.avatar || undefined }));
        setAdminAccounts(enriched);
        try {
          localStorage.setItem('anda_admin_accounts', JSON.stringify(enriched));
        } catch {}
      }
    } catch (e: any) {
      setError(e.message || "Operation failed");
    }
  }, []);

  /**
   * Pulls this user's own profile from the website so a change made there
   * (name, phone, role or photo) reaches the till without re-logging in.
   */
  const syncProfileFromCloud = useCallback(async (): Promise<boolean> => {
    try {
      const result = await api.post<{
        changed?: boolean;
        profile?: {
          id?: string;
          fullName?: string;
          email?: string;
          phone?: string;
          role?: string;
          avatar?: string | null;
        } | null;
      }>('/pos-sync?action=pull-profile', {});
      const profile = result?.profile;
      if (!result?.changed || !profile) return false;

      const email = (profile.email || adminSession?.email || '').toLowerCase().trim();
      const avatar = profile.avatar !== undefined ? (profile.avatar || undefined) : undefined;
      if (email && avatar !== undefined) {
        try {
          const avatars = JSON.parse(localStorage.getItem('anda_admin_avatars') || '{}');
          avatars[email] = avatar;
          localStorage.setItem('anda_admin_avatars', JSON.stringify(avatars));
        } catch {}
      }

      setAdminSession(prev => {
        const nextSession: AdminSession = {
          ...prev,
          adminName: profile.fullName ?? prev.adminName,
          email: profile.email ?? prev.email,
          phone: profile.phone ?? prev.phone,
          avatar: avatar !== undefined ? avatar : prev.avatar,
          adminRole: profile.role === 'Super Admin' || profile.role === 'Store Manager'
            || profile.role === 'Inventory Dispatcher' || profile.role === 'Cashier'
            ? profile.role
            : prev.adminRole,
        };
        try {
          localStorage.setItem('anda_admin_session', JSON.stringify(nextSession));
        } catch {}
        return nextSession;
      });

      setAdminAccounts(prev => {
        const next = prev.map(account =>
          account.email && account.email.toLowerCase().trim() === email
            ? {
                ...account,
                fullName: profile.fullName ?? account.fullName,
                email: profile.email ?? account.email,
                phone: profile.phone ?? account.phone,
                avatar: avatar !== undefined ? avatar : account.avatar,
              }
            : account,
        );
        try {
          localStorage.setItem('anda_admin_accounts', JSON.stringify(next));
        } catch {}
        return next;
      });

      return true;
    } catch {
      return false;
    }
  }, [adminSession?.email]);

  const addAdminAccount = async (account: Omit<AdminAccount, 'id'> & { pin?: string }): Promise<AdminAccount> => {
    try {
      const created = await api.post<AdminAccount>('/admin-accounts', account);
      setAdminAccounts(prev => [created, ...prev]);
      return created;
    } catch (e: any) {
      setError(e.message || 'Operation failed');
      throw e;
    }
  };

  const updateAdminAccount = async (id: string, updates: Partial<AdminAccount>) => {
    const sessionEmail = (adminSession?.email || '').toLowerCase().trim();

    // Persist avatar locally if provided
    if (updates.avatar !== undefined) {
      try {
        const avatars = JSON.parse(localStorage.getItem('anda_admin_avatars') || '{}');
        const match = adminAccounts.find(item => item && item.id === id);
        const emailKey = (updates.email || match?.email || adminSession?.email || '').toLowerCase().trim();
        if (emailKey) avatars[emailKey] = updates.avatar;
        if (id && id !== 'self') avatars[id] = updates.avatar;
        if (adminSession?.adminId) avatars[adminSession.adminId] = updates.avatar;
        localStorage.setItem('anda_admin_avatars', JSON.stringify(avatars));
      } catch {}
    }

    setAdminAccounts(prev =>
      prev.map(account =>
        account.id === id || (id === 'self' && account.email.toLowerCase().trim() === sessionEmail)
          ? { ...account, ...updates }
          : account
      )
    );

    const account = adminAccounts.find(item => item && item.id === id);
    const isCurrentUser =
      id === 'self' ||
      (account && account.email && account.email.toLowerCase().trim() === sessionEmail) ||
      (updates.email && updates.email.toLowerCase().trim() === sessionEmail) ||
      (adminSession?.adminId && adminSession.adminId === id);

    if (isCurrentUser) {
      setAdminSession(prev => {
        const nextSession: AdminSession = {
          ...prev,
          adminName: updates.fullName ?? prev.adminName,
          email: updates.email ?? prev.email,
          phone: updates.phone ?? prev.phone,
          avatar: updates.avatar !== undefined ? updates.avatar : prev.avatar,
          adminRole:
            updates.role === 'super_admin'
              ? 'Super Admin'
              : updates.role === 'manager'
              ? 'Store Manager'
              : updates.role === 'cashier'
              ? 'Cashier'
              : updates.role === 'admin'
              ? 'Inventory Dispatcher'
              : prev.adminRole,
        };
        try {
          localStorage.setItem('anda_admin_session', JSON.stringify(nextSession));
        } catch {}
        return nextSession;
      });
    }

    // Determine actual backend target ID
    let targetBackendId = id;
    if (targetBackendId === 'self') {
      const match = adminAccounts.find(item => item && item.email && item.email.toLowerCase().trim() === sessionEmail);
      targetBackendId = match?.id || adminSession?.adminId || '';
    }

    // Safe backend payload omitting client-only avatar
    const { profileImage: _p, ...backendUpdates } = updates;
    if (targetBackendId && Object.keys(backendUpdates).length > 0) {
      try {
        // The id travels as a query parameter, never as an extra path segment.
        // On Vercel only /api/<one-segment> reaches the hosted function, so a
        // request shaped like /api/admin-accounts/abc is answered by the platform
        // with a 404 before the API ever runs. Both the till and the hosted
        // handler read the id from the query string.
        await api.patch(`/admin-accounts?id=${encodeURIComponent(targetBackendId)}`, backendUpdates);
      } catch (e: any) {
        setError(e.message || 'Operation failed');
        throw e;
      }
    }
  };

  const deleteAdminAccount = async (id: string) => {
    setAdminAccounts(prev => prev.filter(account => account.id !== id));
    try {
      await api.delete(`/admin-accounts?id=${encodeURIComponent(id)}`);
    } catch (e: any) { setError(e.message || 'Operation failed'); }
  };

  const changeAdminPassword = async (currentPin: string, newPin: string) => {
    const sessionEmail = (adminSession?.email || '').toLowerCase().trim();
    let account = adminAccounts.find(item => item && item.email && item.email.toLowerCase().trim() === sessionEmail);
    let targetId = account?.id || adminSession?.adminId;

    if (!targetId) {
      try {
        const accounts = await api.get<AdminAccount[]>('/admin-accounts');
        setAdminAccounts(accounts);
        account = accounts.find(item => item && item.email && item.email.toLowerCase().trim() === sessionEmail);
        targetId = account?.id;
      } catch {}
    }

    if (!targetId) throw new Error('Active admin account was not found');
    await api.patch(`/admin-accounts?id=${encodeURIComponent(targetId)}`, { currentPin, pin: newPin });
  };

  return (
    <StoreContext.Provider
      value={{
        products,
        loading,
        error,
        fetchProducts,
        addProduct,
        updateProduct,
        deleteProduct,
        updateProductStock,
        brands,
        loadingBrands,
        fetchBrands,
        addBrand,
        deleteBrand,
        categories,
        loadingCategories,
        fetchCategories,
        updateCategory,
        addCategory,
        deleteCategory,
        toggleCategory,
        orders,
        loadingOrders,
        fetchOrders,
        promoCodes,
        loadingPromos,
        fetchPromoCodes,
        addPromoCode,
        togglePromoCode,
        deletePromoCode,
        validatePromoCode,
        storeSettings,
        fetchSettings,
        hardwareSettings,
        fetchHardwareSettings,
        saveHardwareSettings,
        adminSession,
        adminAccounts,
        loadingAdmin,
        loginAdmin,
        logoutAdmin,
        fetchAdminAccounts,
        syncProfileFromCloud,
        addAdminAccount,
        updateAdminAccount,
        deleteAdminAccount,
        changeAdminPassword,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
};

export const useStore = () => {
  const context = useContext(StoreContext);
  if (!context) {
    throw new Error('useStore must be used within a StoreProvider');
  }
  return context;
};
