import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A real (in-memory) SQLite database behind the subset of the D1 binding API
// drizzle uses, migrated with schema.sql + drizzle/*.sql exactly as
// `npm run db:bootstrap:local` does. Lets booking tests run the actual SQL,
// such as placeOrder's single-statement conflict checks.

const root = new URL('../..', import.meta.url).pathname;

type Param = string | number | bigint | null | Uint8Array;
const toParam = (v: unknown): Param =>
  v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Param);

export function createTestD1(): D1Database & { sqlite: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(root, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(root, 'drizzle')).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(root, 'drizzle', f), 'utf8'));
  }

  const statement = (sql: string, params: Param[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args.map(toParam)),
    async run() {
      const r = db.prepare(sql).run(...params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async all() {
      const st = db.prepare(sql);
      const results = st.columns().length ? st.all(...params) : (st.run(...params), []);
      return { success: true, results: results.map(r => ({ ...r })), meta: {} };
    },
    async raw() {
      const st = db.prepare(sql);
      if (!st.columns().length) { st.run(...params); return []; }
      st.setReturnArrays(true);
      return st.all(...params) as unknown[][];
    },
    async first(col?: string) {
      const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
      return row ? (col ? row[col] : { ...row }) : null;
    },
  });

  return {
    sqlite: db,
    prepare: (sql: string) => statement(sql),
    async batch(stmts: { run(): Promise<unknown> }[]) { return Promise.all(stmts.map(s => s.run())); },
    async exec(sql: string) { db.exec(sql); return { count: 1, duration: 0 }; },
  } as unknown as D1Database & { sqlite: DatabaseSync };
}
