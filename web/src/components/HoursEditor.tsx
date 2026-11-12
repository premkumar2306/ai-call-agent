import { DAYS, type WeekHours } from '../business';


export default function HoursEditor({ value, onChange }: { value: WeekHours; onChange: (w: WeekHours) => void }) {
  const set = (d: keyof WeekHours, patch: Partial<WeekHours[keyof WeekHours]>) => onChange({ ...value, [d]: { ...value[d], ...patch } });
  const copyMonday = () => {
    const next = { ...value };
    for (const d of ['tue', 'wed', 'thu', 'fri'] as const) next[d] = { ...value.mon };
    onChange(next);
  };
  return (
    <div className="hours">
      {DAYS.map(([d, name]) => (
        <div key={d} className="hours-row">
          <label className="day">
            <input type="checkbox" checked={value[d].open} onChange={e => set(d, { open: e.target.checked })} />
            {name}
          </label>
          {value[d].open ? (
            <>
              <input type="time" className="input" value={value[d].from} onChange={e => set(d, { from: e.target.value })} aria-label={`${name} opens`} />
              <span className="muted">to</span>
              <input type="time" className="input" value={value[d].to} onChange={e => set(d, { to: e.target.value })} aria-label={`${name} closes`} />
            </>
          ) : <span className="muted small">Closed</span>}
        </div>
      ))}
      <div><button type="button" className="btn-link small" onClick={copyMonday}>Copy Monday's hours to Tue–Fri</button></div>
    </div>
  );
}
