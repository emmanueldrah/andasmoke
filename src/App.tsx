import React, { Suspense, lazy } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import ErrorBoundary from './components/common/ErrorBoundary';
import { useStore } from './context/StoreContext';
import { PageSkeleton } from './components/common/LoadingStates';

const AdminPortal = lazy(() => import('./components/admin/AdminPortal').then(m => ({ default: m.AdminPortal })));

function AppLayout() {
  const { storeSettings } = useStore();
  const location = useLocation();

  const appRoutes = new Set(['/', '/pos', '/counter', '/products', '/inventory', '/categories', '/discounts', '/team', '/reports']);
  const isAppRoute = appRoutes.has(location.pathname) || location.pathname.startsWith('/admin');
  const pageTitle = `${storeSettings.storeName} | POS`;

  React.useEffect(() => {
    if (isAppRoute) document.title = pageTitle;
  }, [isAppRoute, pageTitle]);

  if (!isAppRoute) return <Navigate to="/" replace />;

  return (
    <>
      <Helmet>
        <html lang="en" />
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{pageTitle}</title>
      </Helmet>
      <ErrorBoundary>
        <Suspense fallback={<PageSkeleton />}>
          <AdminPortal />
        </Suspense>
      </ErrorBoundary>
    </>
  );
}

export default function App() {
  return <AppLayout />;
}
