// Shared building blocks for the admin UI. Styling lives in index.css.
import { useId, type ReactNode, type ButtonHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, description, children, actions }: { title?: ReactNode; description?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          {title && <h2 className="card-title">{title}</h2>}
          {actions}
        </div>
      )}
      {description && <p className="card-hint">{description}</p>}
      {children}
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'primary', size, busy, children, className, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm'; busy?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined}
      className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)}>
      {busy ? 'Saving…' : children}
    </button>
  );
}

/** A labelled form control. Pass the control as children; it gets the label's id. */
export function Field({ label, help, children }: { label: ReactNode; help?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {help && <span className="help" id={`${id}-help`}>{help}</span>}
    </div>
  );
}

export function Badge({ tone, children }: { tone?: 'success' | 'warning' | 'danger' | 'accent'; children: ReactNode }) {
  return <span className={cx('badge', tone && `badge-${tone}`)}>{children}</span>;
}

export function Notice({ tone, children }: { tone?: 'success' | 'error' | 'warning'; children: ReactNode }) {
  return <div className={cx('notice', tone && `notice-${tone}`)} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Sub-navigation inside a page (e.g. Settings sections). */
export function Segmented<T extends string>({ items, value, onChange, label }: { items: { key: T; label: string }[]; value: T; onChange: (k: T) => void; label: string }) {
  return (
    <nav className="segmented" aria-label={label}>
      {items.map(i => (
        <button key={i.key} type="button" aria-current={i.key === value ? 'page' : undefined} onClick={() => onChange(i.key)}>{i.label}</button>
      ))}
    </nav>
  );
}

export function Loading({ what = 'Loading…' }: { what?: string }) {
  return <p className="muted" role="status">{what}</p>;
}
