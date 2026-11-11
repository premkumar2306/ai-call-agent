import type React from 'react';

// Inline-style tokens for older pages, matching the classes in index.css.
// New code should use the components in components/ui.tsx instead.
export const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 20, boxShadow: 'var(--shadow)', minWidth: 0 };
export const btn: React.CSSProperties = { background: 'var(--accent)', color: '#fff', border: '1px solid transparent', padding: '9px 16px', borderRadius: 8, fontSize: 15, fontWeight: 600 };
export const ghost: React.CSSProperties = { background: 'var(--surface)', color: 'var(--text-strong)', border: '1px solid var(--border-strong)', padding: '8px 14px', borderRadius: 8, fontSize: 15, fontWeight: 500 };
export const input: React.CSSProperties = {
  width: '100%', background: 'var(--input-bg)', border: '1px solid var(--border-strong)', borderRadius: 8,
  color: 'var(--text-strong)', padding: '9px 12px', fontSize: 15, boxSizing: 'border-box',
};
export const label: React.CSSProperties = { display: 'grid', gap: 6, fontSize: 14, fontWeight: 500, color: 'var(--text)' };
export const h2: React.CSSProperties = { margin: '0 0 4px', fontSize: 17, color: 'var(--text-strong)' };
export const hint: React.CSSProperties = { margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 14 };
export const msgStyle = (ok: boolean): React.CSSProperties => ({ margin: '12px 0 0', fontSize: 14, color: ok ? 'var(--success)' : 'var(--danger)' });
