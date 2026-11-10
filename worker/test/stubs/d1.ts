import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

// In-memory D1 for route tests: enough of the D1 API for drizzle-orm/d1
// (prepare/bind/all/raw/run/first/batch) on top of Node's built-in SQLite.
// The schema is exactly what production gets: schema.sql + every migration.

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map(p => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)));
  }
  private st() { return this.db.prepare(this.sql); }
  async all() { return this.allSync(); }
  allSync() {
    const results = this.st().all(...(this.params as any[])).map(r => ({ ...r }));
    return { results, success: true, meta: { changes: 0 } };
  }
  async raw() {
    const st = this.st();
    st.setReturnArrays(true);
    return st.all(...(this.params as any[]));
  }
  async run() {
    const r = this.st().run(...(this.params as any[]));
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(col?: string) {
    const row = this.st().get(...(this.params as any[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    return col ? row[col] : { ...row };
  }
}

export function createD1() {
  const db = new DatabaseSync(':memory:');
  const root = new URL('../../', import.meta.url);
  db.exec(readFileSync(new URL('schema.sql', root), 'utf8'));
  const dir = new URL('drizzle/', root);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, dir), 'utf8'));
  }
  return {
    sqlite: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map(s => s.allSync());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) { db.exec(sql); return { count: 0, duration: 0 }; },
  };
}

export function createKV() {
  const m = new Map<string, string>();
  return {
    map: m,
    async get(k: string, type?: string) {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
  };
}

export const executionCtx = {
  waitUntil(p: Promise<unknown>) { p.catch(() => {}); },
  passThroughOnException() {},
  props: {},
};
