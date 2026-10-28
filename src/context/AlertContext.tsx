import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertCircle, Info, X, AlertTriangle } from 'lucide-react';

export type AlertType = 'success' | 'error' | 'info' | 'warning';

interface Alert {
  id: string;
  message: string;
  type: AlertType;
  duration?: number;
  persistent?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface AlertContextType {
  showAlert: (
    message: string,
    type?: AlertType,
    options?: {
      duration?: number;
      persistent?: boolean;
      action?: { label: string; onClick: () => void };
    }
  ) => void;
  removeAlert: (id: string) => void;
}

const AlertContext = createContext<AlertContextType | undefined>(undefined);

export const AlertProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const showAlert = useCallback(
    (
      message: string,
      type: AlertType = 'info',
      options?: {
        duration?: number;
        persistent?: boolean;
        action?: { label: string; onClick: () => void };
      }
    ) => {
      const id = Math.random().toString(36).substring(2, 9);
      const { duration = 5000, persistent = false, action } = options || {};
      const newAlert: Alert = { id, message, type, duration, persistent, action };
      setAlerts(prev => [...prev, newAlert]);

      if (!persistent && duration) {
        setTimeout(() => removeAlert(id), duration);
      }
    },
    []
  );

  const removeAlert = (id: string) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  };

  const alertColors = {
    success: { border: 'color-mix(in srgb, var(--jade) 38%, var(--border-color))', icon: 'text-[var(--jade)]' },
    error: { border: 'color-mix(in srgb, var(--danger) 38%, var(--border-color))', icon: 'text-[var(--danger)]' },
    warning: { border: 'color-mix(in srgb, var(--accent) 38%, var(--border-color))', icon: 'text-[var(--accent)]' },
    info: { border: 'color-mix(in srgb, var(--violet) 38%, var(--border-color))', icon: 'text-[var(--violet)]' },
  };

  return (
    <AlertContext.Provider value={{ showAlert, removeAlert }}>
      {children}
      <div className="fixed inset-x-3 bottom-6 z-50 flex max-w-md flex-col gap-3 pointer-events-none sm:inset-x-auto sm:right-6 sm:w-full">
        {alerts.map(alert => {
          const colors = alertColors[alert.type];
          return (
            <div
              key={alert.id}
              className="alert-enter glass-notice pointer-events-auto p-4 rounded-lg border text-[var(--text-primary)]"
              style={{ borderColor: colors.border }}
            >
                <div className="flex gap-3">
                  <div className="flex-shrink-0 pt-0.5">
                    {alert.type === 'success' && <CheckCircle2 className={`w-5 h-5 ${colors.icon}`} />}
                    {alert.type === 'error' && <AlertCircle className={`w-5 h-5 ${colors.icon}`} />}
                    {alert.type === 'warning' && <AlertTriangle className={`w-5 h-5 ${colors.icon}`} />}
                    {alert.type === 'info' && <Info className={`w-5 h-5 ${colors.icon}`} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-snug">{alert.message}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {alert.action && (
                      <button
                        onClick={alert.action.onClick}
                        className="text-sm font-medium text-[var(--text-primary)] hover:text-[var(--accent)] hover:underline transition-colors"
                      >
                        {alert.action.label}
                      </button>
                    )}
                    <button
                      onClick={() => removeAlert(alert.id)}
                      className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors p-1"
                      aria-label="Dismiss alert"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
            </div>
          );
        })}
      </div>
    </AlertContext.Provider>
  );
};

export const useAlert = () => {
  const context = useContext(AlertContext);
  if (!context) {
    throw new Error('useAlert must be used within an AlertProvider');
  }
  return context;
};
