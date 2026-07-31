import { useCallback, useRef, useState } from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const DISMISS_AFTER_MS = 4_000;

/**
 * Transient feedback for actions whose result is otherwise invisible — funding
 * a campaign changes a number somewhere else on the page, and without this the
 * user cannot tell a successful click from an ignored one.
 *
 * Errors that a user must act on (insufficient credits, validation failures)
 * stay inline next to the control instead; a toast that disappears is the wrong
 * place for something you need to read twice.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = (nextId.current += 1);
      setToasts((current) => [...current, { id, kind, message }]);
      setTimeout(() => dismiss(id), DISMISS_AFTER_MS);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

export function ToastStack({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;

  return (
    // aria-live so a screen reader announces the result of an action that has
    // no other audible consequence.
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          <span className="toast__dot" />
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
