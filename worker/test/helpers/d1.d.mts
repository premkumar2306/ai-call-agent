export interface TestSqlite {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
  exec(sql: string): void;
}
export function createTestD1(): { db: TestSqlite; d1: D1Database };
export function createTestKV(): KVNamespace & { store: Map<string, string> };
