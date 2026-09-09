"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export type ToastTone = "success" | "error" | "warn" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** Optional second line: the reason behind a failure, or what to do next. */
  detail?: string | null;
}

interface ToastApi {
  push: (tone: ToastTone, message: string, detail?: string | null) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Errors stay until dismissed; a failure the user never saw is worse than a sticky toast. */
const AUTO_DISMISS_MS: Record<ToastTone, number | null> = {
  success: 4000,
  info: 5000,
  warn: 7000,
  error: null,
};

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, detail?: string | null) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-4), { id, tone, message, detail: detail ?? null }]);
      const ttl = AUTO_DISMISS_MS[tone];
      if (ttl !== null) setTimeout(() => dismiss(id), ttl);
    },
    [dismiss]
  );

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* aria-live so a screen reader announces the outcome of an action it cannot see. */}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <div className="toast-body">
              <strong>{t.message}</strong>
              {t.detail && <span className="toast-detail">{t.detail}</span>}
            </div>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
