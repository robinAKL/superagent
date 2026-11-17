import type { ReactNode } from 'react';

/** Shared page chrome: title + subtitle on one row, optional actions on the right (v12). */
export function PageHead({ title, lead, children, id }: { title: string; lead?: string; children?: ReactNode; id?: string }) {
  return (
    <header className="page-head">
      <h1 id={id}>{title}</h1>
      {lead ? <p>{lead}</p> : null}
      {children ? <div className="page-head-actions">{children}</div> : null}
    </header>
  );
}
