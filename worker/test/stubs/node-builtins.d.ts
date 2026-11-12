// The few Node built-ins the D1 test shim uses. @types/node isn't installed
// because it clashes with @cloudflare/workers-types in the shared tsconfig.
declare module 'node:sqlite' {
  interface StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    setReturnArrays(enabled: boolean): void;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
declare module 'node:fs' {
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
  export function readdirSync(path: URL | string): string[];
}
interface ImportMeta { url: string }
declare module 'node:crypto' {
  interface Hmac { update(data: string): Hmac; digest(enc: 'hex' | 'base64'): string }
  export function createHmac(alg: string, key: string): Hmac;
}
