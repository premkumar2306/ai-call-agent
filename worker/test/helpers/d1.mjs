// In-memory D1 + KV for tests: node:sqlite with the real schema.sql and
// drizzle/ migrations applied, so SQL in services runs against the same
// tables production has. Plain JS (types in d1.d.mts) because the worker's
// tsconfig has Workers types, not Node's.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params.map(norm)); }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params), success: true, meta: {} }; }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return col ? row[col] : { ...row };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  }
  async raw() { return this.db.prepare(this.sql).all(...this.params).map(r => Object.values(r)); }
}

export function createTestD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(root, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(root, 'drizzle')).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(root, 'drizzle', f), 'utf8'));
  }
  const d1 = {
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) { db.exec(sql); return { count: 0, duration: 0 }; },
  };
  return { db, d1 };
}

export function createTestKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}
