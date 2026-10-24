// Minimal stand-in so modules that import CallRelay can load under Node.
export class DurableObject<Env = unknown> {
  constructor(public ctx: unknown, public env: Env) {}
}
