// Just the Node APIs the tests use (they run in Node under vitest). The
// project type-checks against @cloudflare/workers-types, which can't be
// mixed with @types/node, so these are declared by hand.

interface ImportMeta { readonly url: string }

declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:sqlite' {
  type SQLValue = string | number | bigint | null | Uint8Array;
  export class StatementSync {
    run(...params: SQLValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(...params: SQLValue[]): any[];
    get(...params: SQLValue[]): any;
    columns(): unknown[];
    setReturnArrays(enabled: boolean): void;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
