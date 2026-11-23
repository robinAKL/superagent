import type { ReactNode } from 'react';

/** Loading: the shape of what is coming. It never states a conclusion ("removed", "0 items") before the data arrives. */
export function Loading({ rows = 3, label }: { rows?: number; label: string }) {
  return <div className="skeleton" role="status" aria-label={label}>
    {Array.from({ length: rows * 3 }, (_, index) => <span key={index} />)}
  </div>;
}

/** Empty: what belongs here and the one action that fills it. No filters, counts or table heads. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="state-empty"><p>{children}</p>{action}</div>;
}

/** Error: what broke and what to do about it. */
export function LoadError({ children, onRetry, retryLabel }: { children: ReactNode; onRetry?: () => void; retryLabel?: string }) {
  return <div className="state-error" role="alert"><p>{children}</p>
    {onRetry ? <button className="btn" type="button" onClick={onRetry}>{retryLabel}</button> : null}
  </div>;
}
