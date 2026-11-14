export function renderPlivoVerify(r: {
  workerUrl: string;
  health: { ok: boolean; status: number | string };
  unsigned: { status: number | string };
  report: any | null;
  reportError?: string;
}): { lines: string[]; ok: boolean; next: string[] };
export function scrubAll(text: string, values: string[]): string;
