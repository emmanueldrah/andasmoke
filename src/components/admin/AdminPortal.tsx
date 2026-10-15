import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Boxes,
  LogOut,
  Truck,
  Tag,
  UserCheck,
  Layers,
  Plus,
  Sun,
  Moon,
  AlertTriangle,
  RefreshCw,
  ScanLine,
  PanelLeft,
  Menu,
  X,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useStore } from '../../context/StoreContext';
import { useAlert } from '../../context/AlertContext';
import { useTheme } from '../../context/ThemeContext';
import { AdminLoginView } from './AdminLoginView';
import { AdminProductsScreen } from './screens/AdminProductsScreen';
import { AdminAccountsManagementScreen } from './screens/AdminAccountsManagementScreen';
import { POSProductModal } from './POSProductModal';
import { AdminMyProfilePanel } from './components/AdminMyProfilePanel';
import {
  AdminInventoryScreen,
  AdminPromotionsScreen,
} from './screens/AdminPOSManagementScreens';
import { AdminPOSCatalogScreen } from './screens/AdminPOSCatalogScreen';
import { AdminPOSWorkspace } from './screens/AdminPOSWorkspace';
import { BrandMark } from '../common/BrandMark';
import { checkLocalServer } from '../../lib/health';
import { api } from '../../lib/api';
import { AdminSession, Product } from '../../types';

type AdminTab =
  | 'pos'
  | 'products'
  | 'inventory'
  | 'promos'
  | 'categories'
  | 'accounts';

interface NavItem {
  id: AdminTab;
  label: string;
  icon: React.ElementType;
  group: 'counter' | 'stock' | 'manage';
}

const navItems: NavItem[] = [
  { id: 'pos', label: 'Counter', icon: ScanLine, group: 'counter' },
  { id: 'inventory', label: 'Inventory', icon: Truck, group: 'stock' },
  { id: 'products', label: 'Products', icon: Boxes, group: 'stock' },
  { id: 'categories', label: 'Categories', icon: Layers, group: 'stock' },
  { id: 'promos', label: 'Discounts', icon: Tag, group: 'manage' },
  { id: 'accounts', label: 'Team', icon: UserCheck, group: 'manage' },
];

const navGroups: { key: NavItem['group']; label: string }[] = [
  { key: 'counter', label: 'Register' },
  { key: 'stock', label: 'Stockroom' },
  { key: 'manage', label: 'Manage' },
];

const roleAccess: Record<AdminSession['adminRole'], AdminTab[]> = {
  'Super Admin': ['pos', 'inventory', 'products', 'categories', 'promos', 'accounts'],
  'Store Manager': ['pos', 'inventory', 'products', 'categories', 'promos'],
  'Inventory Dispatcher': ['pos', 'inventory', 'products', 'categories'],
  'Cashier': ['pos'],
};

const tabLabels: Record<AdminTab, string> = {
  pos: 'Counter',
  products: 'Products',
  inventory: 'Inventory',
  categories: 'Categories',
  promos: 'Discounts',
  accounts: 'Team',
};

const tabEyebrows: Record<AdminTab, string> = {
  pos: 'Register',
  products: 'Stockroom',
  inventory: 'Stockroom',
  categories: 'Stockroom',
  promos: 'Manage',
  accounts: 'Manage',
};

// Navigation state belongs in readable paths, not implementation query strings.
const tabPaths: Record<AdminTab, string> = {
  pos: '/counter',
  products: '/products',
  inventory: '/inventory',
  categories: '/categories',
  promos: '/discounts',
  accounts: '/team',
};

const pathTabs: Record<string, AdminTab> = Object.fromEntries(
  Object.entries(tabPaths).map(([tab, path]) => [path, tab as AdminTab]),
) as Record<string, AdminTab>;

const RAIL_KEY = 'cr_admin_rail_collapsed';

class AdminTabErrorBoundary extends React.Component<
  { children: React.ReactNode; tabName: string; onReset: () => void },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error in Admin Tab:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-2xl border border-[var(--danger-soft)] bg-[var(--danger-soft)] p-6 text-center max-w-xl mx-auto my-8">
          <div className="w-12 h-12 rounded-2xl bg-[var(--bg-card)] text-[var(--danger)] flex items-center justify-center mx-auto mb-3">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-[var(--text-primary)] mb-1">
            Failed to load {this.props.tabName}
          </h3>
          <p className="text-sm text-[var(--text-muted)] mb-3">
            An unexpected error occurred while loading this view:
          </p>
          <p className="font-mono text-xs text-[var(--danger)] bg-[var(--bg-card)] p-2.5 rounded-xl border border-[var(--border-color)] mb-5 break-words text-left">
            {this.state.error?.message || 'Unknown error'}
          </p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="lux-btn lux-btn--primary"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Try Again
            </button>
            <button
              onClick={this.props.onReset}
              className="lux-btn lux-btn--outline"
            >
              Back to Counter
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export const AdminPortal: React.FC = () => {
  const store = useStore();
  const { showAlert } = useAlert();
  const location = useLocation();
  const navigate = useNavigate();
  const { isDarkMode, toggleTheme } = useTheme();

  const tabFromPath = pathTabs[location.pathname];
  const legacyRequestedTab = new URLSearchParams(location.search).get('tab');
  const isCashier = store.adminSession.adminRole === 'Cashier';
  const accessibleTabs = roleAccess[store.adminSession.adminRole] || roleAccess['Cashier'];
  const defaultTab: AdminTab = accessibleTabs.includes('pos') ? 'pos' : accessibleTabs[0] || 'inventory';
  const requestedTab = tabFromPath || legacyRequestedTab;
  const currentTab: AdminTab = accessibleTabs.includes(requestedTab as AdminTab) ? requestedTab as AdminTab : defaultTab;
  const visibleNavItems = navItems.filter(item => accessibleTabs.includes(item.id));

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<Product | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; }
  });
  const [online, setOnline] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ pendingCount: number; syncedCount: number } | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const flushSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const res = await api.post<{ flushed: number; pending: number }>('/pos-sync?action=flush', {});
      setSyncStatus(prev => prev ? { ...prev, pendingCount: res.pending } : { pendingCount: res.pending, syncedCount: 0 });
      if (res.flushed > 0) {
        showAlert(`Synced ${res.flushed} sale${res.flushed === 1 ? '' : 's'} to cloud`, 'success');
      }
    } catch {
      // Offline / server unreachable
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    let active = true;
    const fetchSync = () => {
      void api.get<{ pendingCount: number; syncedCount: number }>('/pos-sync?action=status')
        .then(res => {
          if (!active) return;
          setSyncStatus(res);
          if (res.pendingCount > 0 && navigator.onLine) {
            void flushSync();
          }
        })
        .catch(() => {});
    };
    fetchSync();
    const syncTimer = window.setInterval(fetchSync, 12_000);
    return () => { active = false; window.clearInterval(syncTimer); };
  }, []);

  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);

  useEffect(() => {
    const andaPos = (window as any).andaPos;
    if (andaPos?.onUpdateDownloaded) {
      return andaPos.onUpdateDownloaded((info: any) => {
        setUpdateAvailable(info?.version || 'new');
      });
    }
  }, []);

  useEffect(() => {
    let active = true;
    const check = () => {
      void checkLocalServer().then(health => { if (active) setOnline(health.ok); });
    };
    check();
    const timer = window.setInterval(check, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [currentTab]);

  // Existing saved links keep working, then quietly become the readable URL.
  useEffect(() => {
    if (tabFromPath || !accessibleTabs.includes(legacyRequestedTab as AdminTab)) return;
    const params = new URLSearchParams(location.search);
    params.delete('tab');
    navigate({ pathname: tabPaths[legacyRequestedTab as AdminTab], search: params.toString() ? `?${params}` : '' }, { replace: true });
  }, [accessibleTabs, legacyRequestedTab, location.search, navigate, tabFromPath]);

  const toggleRail = () => {
    setRailCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(RAIL_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  const refreshAdminData = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const results = await Promise.allSettled([
        store.fetchProducts({ includeUnpublished: true }),
        store.fetchOrders(),
      ]);
      if (results.some(result => result.status === 'rejected')) {
        showAlert('Some portal data could not be refreshed. Please try again.', 'error');
      } else {
        showAlert('Portal data refreshed.', 'success');
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleLogout = () => {
    if (confirmLogout) {
      store.logoutAdmin();
      showAlert('Logged out successfully', 'success');
    } else {
      setConfirmLogout(true);
      setTimeout(() => setConfirmLogout(false), 4000);
    }
  };

  const handleAddProduct = () => {
    setProductToEdit(null);
    setProductModalOpen(true);
  };

  const handleEditProduct = (product: Product) => {
    setProductToEdit(product);
    setProductModalOpen(true);
  };

  const handleTabChange = (tab: AdminTab) => {
    if (!accessibleTabs.includes(tab)) return;
    const params = new URLSearchParams(location.search);
    params.delete('tab');
    navigate({ pathname: tabPaths[tab], search: params.toString() ? `?${params}` : '' }, { replace: true });
  };

  const renderNav = (collapsed: boolean) => (
    <div className="flex h-full min-h-0 flex-col">
      {/* Brand */}
      <div className={`flex h-16 shrink-0 items-center gap-3 border-b border-[var(--border-color)] ${collapsed ? 'justify-center px-2' : 'px-4'}`}>
        <BrandMark name={store.storeSettings.storeName} className="h-9 w-9 rounded-lg text-[10px]" />
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold tracking-tight text-[var(--text-primary)]">{store.storeSettings.storeName}</p>
            <p className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-subtle)]">{store.adminSession.adminRole}</p>
          </div>
        )}
      </div>

      {/* Nav groups */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-5">
          {navGroups.map(group => {
            const items = visibleNavItems.filter(item => item.group === group.key);
            if (!items.length) return null;
            return (
              <li key={group.key}>
                {!collapsed && (
                  <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-subtle)]">{group.label}</p>
                )}
                <ul className="space-y-1">
                  {items.map(item => {
                    const Icon = item.icon;
                    const isActive = currentTab === item.id;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          title={collapsed ? item.label : undefined}
                          onClick={() => handleTabChange(item.id)}
                          className={`relative flex w-full items-center gap-3 rounded-xl py-2.5 text-sm font-semibold transition-colors ${
                            collapsed ? 'justify-center px-0' : 'px-3'
                          } ${
                            isActive
                              ? 'clay-surface bg-[var(--accent-soft)] text-[var(--accent)] shadow-[inset_2px_0_0_0_var(--accent)]'
                              : 'text-[var(--text-muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)]'
                          }`}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          {!collapsed && <span className="truncate">{item.label}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Bottom cluster */}
      <div className={`shrink-0 border-t border-[var(--border-color)] p-3 ${collapsed ? 'flex flex-col items-center gap-2' : 'space-y-1'}`}>
        <div
          className={`flex items-center gap-2 rounded-xl px-3 py-2 ${collapsed ? 'justify-center px-0 w-full' : ''} ${
            online ? 'bg-[var(--jade-soft)] text-[var(--jade)]' : 'bg-[var(--danger-soft)] text-[var(--danger)]'
          }`}
          title={online ? 'Connected to the cloud POS service' : 'Cloud unavailable: sales cannot be recorded'}
        >
          {online ? <Wifi className="h-4 w-4 shrink-0" /> : <WifiOff className="h-4 w-4 shrink-0" />}
          {!collapsed && (
            <span className="truncate text-xs font-bold">{online ? 'Online' : 'Offline'}</span>
          )}
        </div>

        <button
          type="button"
          onClick={toggleTheme}
          title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold text-[var(--text-muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)] ${collapsed ? 'justify-center px-0' : ''}`}
        >
          {isDarkMode ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
          {!collapsed && <span>{isDarkMode ? 'Light mode' : 'Dark mode'}</span>}
        </button>

        <button
          type="button"
          onClick={() => setProfilePanelOpen(true)}
          title="My account, profile & password"
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[var(--accent-soft)] ${collapsed ? 'justify-center px-0' : ''}`}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border-color)] bg-[var(--accent-soft)] text-[var(--accent)] text-xs font-bold">
            {store.adminSession.avatar ? (
              <img src={store.adminSession.avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              <span>{(store.adminSession.adminName || 'A').charAt(0).toUpperCase()}</span>
            )}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-[var(--text-primary)] leading-tight">{store.adminSession.adminName}</p>
              <p className="truncate text-[10px] text-[var(--text-subtle)] leading-tight">{store.adminSession.adminRole}</p>
            </div>
          )}
        </button>

        {confirmLogout ? (
          <div className={`flex items-center gap-2 rounded-xl bg-[var(--danger-soft)] p-2 ${collapsed ? 'w-full' : ''}`}>
            <button
              onClick={handleLogout}
              className="flex-1 rounded-lg bg-[var(--danger)] px-3 py-2 text-xs font-bold text-[#FFF6F2] transition hover:brightness-110"
            >
              Confirm
            </button>
            {!collapsed && (
              <button
                onClick={() => setConfirmLogout(false)}
                className="rounded-lg px-2 py-2 text-xs font-bold text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={handleLogout}
            title="Sign out"
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold text-[var(--text-muted)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] ${collapsed ? 'justify-center px-0' : ''}`}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && <span>Sign out</span>}
          </button>
        )}
      </div>
    </div>
  );

  // Keep all hooks above this gate so login does not change hook order.
  if (!store.adminSession.isLoggedIn) {
    return <AdminLoginView mode="pos" onSuccess={() => {}} />;
  }

  if (store.loadingAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-main)] text-[var(--text-muted)]">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[var(--border-color)] border-t-[var(--accent)]" />
          <p className="mt-3 text-sm font-semibold">Opening {isCashier ? 'cashier' : 'admin'} portal...</p>
        </div>
      </div>
    );
  }

  const railWidth = railCollapsed ? 'lg:pl-[84px]' : 'lg:pl-[264px]';

  return (
    <div className="admin-shell min-h-screen text-[var(--text-primary)]">
      <div className="admin-shell__frame">
        {/* Desktop sidebar */}
        <aside
          className={`glass-panel admin-shell__sidebar fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-[var(--border-color)] transition-[width] duration-200 lg:flex ${railCollapsed ? 'w-[84px]' : 'w-[264px]'}`}
        >
          {renderNav(railCollapsed)}
        </aside>

        {/* Mobile drawer */}
        {mobileNavOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div
              className="absolute inset-0 bg-black/55 backdrop-blur-sm"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden="true"
            />
            <aside className="glass-panel absolute inset-y-0 left-0 flex w-[280px] flex-col border-r border-[var(--border-color)] shadow-[var(--shadow-card)]">
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="absolute right-3 top-4 rounded-lg p-1.5 text-[var(--text-subtle)] transition hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)]"
                aria-label="Close menu"
              >
                <X className="h-4 w-4" />
              </button>
              {renderNav(false)}
            </aside>
          </div>
        )}

        {/* Main column */}
        <div className={`admin-shell__main min-h-screen transition-[padding] duration-200 ${railWidth}`}>
          {/* Contextual top bar */}
          <header className="glass-panel admin-shell__header sticky top-0 z-30 border-b border-[var(--border-color)]">
            <div className="flex h-16 items-center gap-3 px-4 md:px-6">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                className="rounded-xl p-2 text-[var(--text-muted)] transition hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)] lg:hidden"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={toggleRail}
                className="hidden rounded-xl p-2 text-[var(--text-subtle)] transition hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)] lg:block"
                aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                <PanelLeft className="h-4.5 w-4.5" />
              </button>

              <div className="min-w-0 flex-1">
                <p className="eyebrow">{isCashier ? 'Cashier portal' : tabEyebrows[currentTab]}</p>
                <h1 className="brand-display -mt-0.5 truncate text-xl font-semibold leading-tight text-[var(--text-primary)]">
                  {isCashier ? 'Register' : tabLabels[currentTab]}
                </h1>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {updateAvailable && (
                  <button
                    type="button"
                    onClick={() => (window as any).andaPos?.restartAndInstallUpdate?.()}
                    className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/15 px-3 py-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition cursor-pointer"
                    title="Click to restart the till and apply update"
                  >
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    <span>Update ready (v{updateAvailable}) - Restart</span>
                  </button>
                )}

                {syncStatus && syncStatus.pendingCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => void flushSync()}
                    disabled={isSyncing}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1 text-[11px] font-semibold text-[var(--accent)] transition hover:bg-[var(--accent-soft)] cursor-pointer"
                    title="Click to sync pending sales to the cloud"
                  >
                    <RefreshCw className={`h-3 w-3 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span>{syncStatus.pendingCount} pending sync</span>
                  </button>
                ) : (
                  <span
                    className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                    title="All offline sales are backed up and synced to the cloud"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span>Cloud Synced</span>
                  </span>
                )}

                {currentTab === 'products' && (
                  <button onClick={handleAddProduct} className="lux-btn lux-btn--primary lux-btn--sm hidden sm:inline-flex">
                    <Plus className="h-3.5 w-3.5" />
                    Add product
                  </button>
                )}

                <button
                  onClick={() => void refreshAdminData()}
                  disabled={isRefreshing}
                  className="lux-btn lux-btn--ghost lux-btn--sm"
                  title="Refresh data"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                  <span className="hidden md:inline">Refresh</span>
                </button>
              </div>
            </div>
          </header>

          <main className="admin-shell__content px-4 py-5 md:px-6 md:py-6">
            <div className={`mx-auto ${currentTab === 'pos' ? 'max-w-[1600px]' : 'max-w-[1400px]'}`}>
              <AdminTabErrorBoundary
                key={currentTab}
                tabName={tabLabels[currentTab] || currentTab}
                onReset={() => handleTabChange('pos')}
              >
                {currentTab === 'pos' && <AdminPOSWorkspace />}
                {currentTab === 'products' && (
                  <AdminProductsScreen
                    onAddProduct={handleAddProduct}
                    onEditProduct={handleEditProduct}
                  />
                )}
                {currentTab === 'inventory' && <AdminInventoryScreen onAddProduct={handleAddProduct} />}
                {currentTab === 'promos' && <AdminPromotionsScreen />}
                {currentTab === 'categories' && <AdminPOSCatalogScreen />}
                {currentTab === 'accounts' && <AdminAccountsManagementScreen />}
              </AdminTabErrorBoundary>
            </div>
          </main>
        </div>
      </div>

      {!isCashier && (
        <POSProductModal
          isOpen={productModalOpen}
          onClose={() => setProductModalOpen(false)}
          productToEdit={productToEdit}
        />
      )}
      <AdminMyProfilePanel
        isOpen={profilePanelOpen}
        onClose={() => setProfilePanelOpen(false)}
      />
    </div>
  );
};
