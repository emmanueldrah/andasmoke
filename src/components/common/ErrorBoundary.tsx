import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: React.ComponentType<{ error: Error; resetError: () => void }>;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

function isChunkLoadError(error: Error | null) {
  return Boolean(error && (
    error.message?.includes('Failed to fetch dynamically imported module') ||
    error.message?.includes('Importing a module script failed') ||
    error.name === 'ChunkLoadError'
  ));
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false, error: null };
  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
    // If a lazy-loaded chunk fails (stale deployment), reload the page once.
    // Guard with sessionStorage so we don't loop if the chunk is truly gone.
    if (isChunkLoadError(error)) {
      let reloaded: string | null = null;
      try { reloaded = sessionStorage.getItem('chunk_reload_attempted'); } catch {}
      if (!reloaded) {
        try { sessionStorage.setItem('chunk_reload_attempted', '1'); } catch {}
        const url = new URL(window.location.href);
        url.searchParams.set('_reload', String(Date.now()));
        window.location.replace(url.toString());
      } else {
        try { sessionStorage.removeItem('chunk_reload_attempted'); } catch {}
      }
    }
  }

  private resetError = () => {
    this.setState({ hasError: false, error: null });
  };

  private retry = () => {
    if (!isChunkLoadError(this.state.error)) {
      this.resetError();
      return;
    }

    try {
      sessionStorage.removeItem('vite_preload_reload_attempted');
      sessionStorage.removeItem('chunk_reload_attempted');
    } catch {}

    const url = new URL(window.location.href);
    url.searchParams.set('_reload', String(Date.now()));
    window.location.replace(url.toString());
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return React.createElement(this.props.fallback, { error: this.state.error!, resetError: this.resetError });
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-transparent p-4">
          <div className="glass-notice max-w-md w-full text-center p-6">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-[var(--danger-soft)] flex items-center justify-center">
              <AlertCircle className="w-8 h-8 text-[var(--danger)]" />
            </div>
            <h1 className="text-2xl font-serif font-medium text-[var(--text-primary)] mb-2">
              Something went wrong
            </h1>
            <p className="text-[var(--text-muted)] mb-4 text-sm">
              We encountered an unexpected error while rendering this page.
            </p>
            {this.state.error && (
              <div className="glass-inset mb-6 p-3 rounded-xl text-left">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1">Details</p>
                <p className="text-xs font-mono text-[var(--text-primary)] break-words">
                  {this.state.error.message || 'Unknown error'}
                </p>
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-2 justify-center">
              <button
                onClick={this.retry}
                className="lux-btn lux-btn--primary inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition"
              >
                <RefreshCw className="w-4 h-4" />
                {isChunkLoadError(this.state.error) ? 'Reload page' : 'Try Again'}
              </button>
              <button
                onClick={() => { window.location.href = '/'; }}
                className="lux-btn lux-btn--outline inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition"
              >
                Return to Counter
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
