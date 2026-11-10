import { DAYS, type WeekHours } from '../business';

const timeInput: React.CSSProperties = { background: '#0a0a0f', border: '1px solid #2a2a3a', borderRadius: 6, color: '#fff', padding: '6px 8px', colorScheme: 'dark' };

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
        <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', width: 130, fontSize: 14, color: '#ddd' }}>
            <input type="checkbox" checked={value[d].open} onChange={e => set(d, { open: e.target.checked })} />
            {name}
          </label>
          {value[d].open ? (
            <>
              <input type="time" style={timeInput} value={value[d].from} onChange={e => set(d, { from: e.target.value })} aria-label={`${name} opens`} />
              <span style={{ color: '#666' }}>to</span>
              <input type="time" style={timeInput} value={value[d].to} onChange={e => set(d, { to: e.target.value })} aria-label={`${name} closes`} />
            </>
          ) : <span style={{ color: '#666', fontSize: 13 }}>Closed</span>}
        </div>
      ))}
      <button type="button" onClick={copyMonday}
        style={{ justifySelf: 'start', background: 'none', border: 'none', color: '#a78bff', fontSize: 13, cursor: 'pointer', padding: 0 }}>
        Copy Monday's hours to Tue–Fri
      </button>
    </div>
  );
}
