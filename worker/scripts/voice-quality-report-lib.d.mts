export function percentile(values: number[], p: number): number | null;
export function summariseCall(outcome: Record<string, any>, data: Record<string, any> | null, language?: string | null): Record<string, any>;
export function summariseAll(calls: Record<string, any>[]): Record<string, any>;
export function renderReport(input: { business: string; days: number; settings?: Record<string, any> | null; calls: Record<string, any>[] }): string;
