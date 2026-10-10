import React from 'react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import App from './App';
import { ThemeProvider } from './context/ThemeContext';
import { StoreProvider } from './context/StoreContext';
import { ToastProvider } from './context/ToastContext';
import { AlertProvider } from './context/AlertContext';
import ErrorBoundary from './components/common/ErrorBoundary';
import './index.css';

// Recover once when a deployment replaces a lazy-loaded chunk. Without this
// guard a transient network failure can trigger a continuous page-reload loop.
window.addEventListener('vite:preloadError', () => {
  try {
    const reloadKey = 'vite_preload_reload_attempted';
    if (sessionStorage.getItem(reloadKey)) return;
    sessionStorage.setItem(reloadKey, '1');
    const url = new URL(window.location.href);
    url.searchParams.set('_reload', String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    // If browser storage is unavailable, keep the page open instead of risking a loop.
  }
});


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <HelmetProvider>
        <BrowserRouter>
          <ThemeProvider>
            <StoreProvider>
              <ToastProvider>
                <AlertProvider>
                  <App />
                </AlertProvider>
              </ToastProvider>
            </StoreProvider>
          </ThemeProvider>
        </BrowserRouter>
      </HelmetProvider>
    </ErrorBoundary>
  </StrictMode>,
);
