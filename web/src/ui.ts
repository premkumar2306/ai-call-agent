import type React from 'react';

// Shared styles for the owner pages (matching the existing dark dashboard).
export const card: React.CSSProperties = { background: '#12121a', border: '1px solid #222', borderRadius: 12, padding: 20 };
export const btn: React.CSSProperties = { background: '#6c47ff', color: '#fff', border: 'none', padding: '9px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 14 };
export const ghost: React.CSSProperties = { background: 'transparent', color: '#a78bff', border: '1px solid #6c47ff66', padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 14 };
export const input: React.CSSProperties = {
  width: '100%', background: '#0a0a0f', border: '1px solid #2a2a3a', borderRadius: 8,
  color: '#fff', padding: '9px 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box',
};
export const label: React.CSSProperties = { display: 'grid', gap: 6, fontSize: 13, color: '#888' };
export const h2: React.CSSProperties = { margin: '0 0 4px', fontSize: 16, color: '#fff' };
export const hint: React.CSSProperties = { margin: '0 0 16px', color: '#888', fontSize: 13 };
export const msgStyle = (ok: boolean): React.CSSProperties => ({ margin: '12px 0 0', fontSize: 13, color: ok ? '#4ade80' : '#f87171' });
