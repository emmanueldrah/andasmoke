import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

interface Toast {
  id: string;
  message: string;
  type?: 'success' | 'error' | 'info';
  duration: number;
  persistent?: boolean;
}

interface ToastContextType {
  showToast: (message: string, type?: 'success' | 'error' | 'info', duration?: number, persistent?: boolean) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

// Individual toast item with its own countdown progress bar and hover-to-pause
const ToastItem: React.FC<{ toast: Toast; onRemove: (id: string) => void }> = ({ toast, onRemove }) => {
  const [paused, setPaused] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(toast.duration);
  const startRef = useRef(Date.now());

  const startTimer = useCallback(() => {
    startRef.current = Date.now();
    timeoutRef.current = setTimeout(() => {
      onRemove(toast.id);
    }, remainingRef.current);
  }, [toast.id, onRemove]);

  const pauseTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      remainingRef.current -= Date.now() - startRef.current;
    }
    setPaused(true);
  }, []);

  const resumeTimer = useCallback(() => {
    setPaused(false);
    startTimer();
  }, [startTimer]);

  React.useEffect(() => {
    if (!toast.persistent) {
      startTimer();
    }
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [toast.persistent, startTimer]);

  const iconColor =
    toast.type === 'success' ? 'text-[#C59B67]' :
    toast.type === 'error'   ? 'text-[#E07A5F]' :
                               'text-[#9E5A38]';

  const barColor =
    toast.type === 'success' ? 'bg-[#C59B67]' :
    toast.type === 'error'   ? 'bg-[#E07A5F]' :
                               'bg-[#9E5A38]';

  return (
    <div
      onMouseEnter={toast.persistent ? undefined : pauseTimer}
      onMouseLeave={toast.persistent ? undefined : resumeTimer}
      className="toast-enter relative overflow-hidden pointer-events-auto flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-[#1E1915] text-[#FAF7F2] border border-[#3E342B]/80 shadow-xl"
    >
      <div className="flex items-center gap-2">
        {toast.type === 'success' && <CheckCircle2 className={`w-4 h-4 ${iconColor} shrink-0`} />}
        {toast.type === 'error'   && <AlertCircle  className={`w-4 h-4 ${iconColor} shrink-0`} />}
        {toast.type === 'info'    && <Info         className={`w-4 h-4 ${iconColor} shrink-0`} />}
        <p className="text-xs font-sans leading-snug tracking-wide">{toast.message}</p>
      </div>

      <button
        onClick={() => onRemove(toast.id)}
        className="text-[#FAF7F2]/40 hover:text-[#FAF7F2] transition-colors shrink-0 cursor-pointer"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>

      {/* Countdown progress bar */}
      {!toast.persistent && (
        <div
          className={`absolute bottom-0 left-0 h-[3px] ${barColor} origin-left`}
          style={{
            animation: `toast-countdown ${toast.duration}ms linear forwards`,
            animationPlayState: paused ? 'paused' : 'running',
          }}
        />
      )}
    </div>
  );
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback((
    message: string,
    type: 'success' | 'error' | 'info' = 'success',
    duration = 3000,
    persistent = false,
  ) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, message, type, duration, persistent }]);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, removeToast }}>
      {children}
      <div className="fixed bottom-4 right-3 z-[9999] flex flex-col gap-1.5 max-w-[280px] pointer-events-none sm:right-5 sm:max-w-xs">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

