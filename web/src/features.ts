import { useEffect, useState } from 'react';
import { api } from './auth';

// Optional features this deployment has set up (GET /features, booleans).
export interface Features { hindi: boolean; calendar: boolean; whatsapp: boolean; billing: boolean; sms: boolean; email: boolean }

const cache = new Map<string, Promise<Features>>();

export function useFeatures(base: string, auth: Record<string, string>): Features | null {
  const [f, setF] = useState<Features | null>(null);
  const key = `${base}|${JSON.stringify(auth)}`;
  useEffect(() => {
    if (!cache.has(key)) cache.set(key, api<Features>(base, '/features', auth).catch(e => { cache.delete(key); throw e; }));
    let live = true;
    cache.get(key)!.then(x => { if (live) setF(x); }).catch(() => undefined);
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return f;
}
