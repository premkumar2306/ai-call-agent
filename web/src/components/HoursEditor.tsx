import { DAYS, type WeekHours } from '../business';

const timeInput: React.CSSProperties = { background: 'var(--input-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-strong)', padding: '6px 6px', minWidth: 0, flex: '0 1 120px' };

export default function HoursEditor({ value, onChange }: { value: WeekHours; onChange: (w: WeekHours) => void }) {
  const set = (d: keyof WeekHours, patch: Partial<WeekHours[keyof WeekHours]>) => onChange({ ...value, [d]: { ...value[d], ...patch } });
  const copyMonday = () => {
    const next = { ...value };
    for (const d of ['tue', 'wed', 'thu', 'fri'] as const) next[d] = { ...value.mon };
    onChange(next);
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {DAYS.map(([d, name]) => (
        <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', width: 110, fontSize: 14, color: 'var(--text)' }}>
            <input type="checkbox" checked={value[d].open} onChange={e => set(d, { open: e.target.checked })} />
            {name}
          </label>
          {value[d].open ? (
            <>
              <input type="time" style={timeInput} value={value[d].from} onChange={e => set(d, { from: e.target.value })} aria-label={`${name} opens`} />
              <span style={{ color: 'var(--text-subtle)' }}>to</span>
              <input type="time" style={timeInput} value={value[d].to} onChange={e => set(d, { to: e.target.value })} aria-label={`${name} closes`} />
            </>
          ) : <span style={{ color: 'var(--text-subtle)', fontSize: 13 }}>Closed</span>}
        </div>
      ))}
      <button type="button" onClick={copyMonday}
        style={{ justifySelf: 'start', background: 'none', border: 'none', color: 'var(--accent-text)', fontSize: 13, cursor: 'pointer', padding: 0 }}>
        Copy Monday's hours to Tue–Fri
      </button>
    </div>
  );
}
