// Shared building blocks for the admin UI. Styling lives in index.css.
import { useEffect, useId, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { applyTheme, loadTheme, type ThemeChoice } from '../theme';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, description, children, actions, className }: { title?: ReactNode; description?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions || description) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p className="card-hint">{description}</p>}
          </div>
          {actions}
        </div>
      )}
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

export function Badge({ tone, children }: { tone?: 'success' | 'warning' | 'danger' | 'accent' | 'info'; children: ReactNode }) {
  return <span className={cx('badge', tone && `badge-${tone}`)}>{children}</span>;
}

export function Notice({ tone, children }: { tone?: 'success' | 'error' | 'warning' | 'info'; children: ReactNode }) {
  return <div className={cx('notice', tone && `notice-${tone}`)} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

// The one way owner pages say a feature depends on a service the Avery team
// hasn't set up yet: calm, no setting names, nothing for the owner to do.
export function NotAvailable({ feature, children }: { feature: ReactNode; children?: ReactNode }) {
  return (
    <Notice tone="info">
      <span className="strong">{feature} isn't available yet.</span>{' '}
      {children ?? "The Avery team is setting it up. You'll be able to use it here once it's ready."}
    </Notice>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
      {action && <div className="row">{action}</div>}
    </div>
  );
}

/** A table; `cards` turns each row into a small card on phones (give cells data-label). */
export function Table({ head, children, cards = true }: { head: ReactNode[]; children: ReactNode; cards?: boolean }) {
  return (
    <div className="table-wrap">
      <table className={cx('table', cards && 'cards')}>
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

/** A message after an action: green when it worked, red when it didn't. */
export function Status({ msg }: { msg: { text: string; ok: boolean } | null }) {
  if (!msg) return null;
  return <Notice tone={msg.ok ? 'success' : 'error'}>{msg.text}</Notice>;
}

/** Modal dialog; closes on Escape or a click outside. */
export function Dialog({ title, subtitle, onClose, children }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const id = useId();
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={id} onClick={e => e.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} autoFocus aria-label="Close">✕</button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

/** Light / Dark / System, remembered in this browser. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const pick = (t: ThemeChoice) => { setTheme(t); applyTheme(t); };
  return (
    <div className="toggle toggle-full" role="group" aria-label="Theme">
      {(['light', 'dark', 'system'] as const).map(t => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => pick(t)}>
          {t === 'light' ? '☀ Light' : t === 'dark' ? '☾ Dark' : 'System'}
        </button>
      ))}
    </div>
  );
}

/** Two or more views of the same thing (Week / List). */
export function ViewToggle<T extends string>({ value, options, onChange, label }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="toggle" role="group" aria-label={label}>
      {options.map(o => <button key={o.key} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)}>{o.label}</button>)}
    </div>
  );
}
