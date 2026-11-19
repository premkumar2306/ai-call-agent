export interface Burst { start: number; end: number }
export interface HeardRow { turn: number; serverMs: number | null; endpointingMs: number | null; callerEnd: number | null; replyStart: number | null; heardMs: number | null; diffMs: number | null; note: string }
export function readWav(buf: Buffer): { sampleRate: number; samples: Float32Array };
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer;
export function loadAudio(path: string): { sampleRate: number; samples: Float32Array };
export function findDtmf(x: Float32Array, sr: number, opts?: { minMs?: number }): { digit: string; start: number; end: number } | null;
export function findBursts(x: Float32Array, sr: number, opts?: { frameMs?: number; minGapMs?: number; minBurstMs?: number; mask?: [number, number][] }): Burst[];
export function turnsOf(json: unknown): { turns: any[]; syncDtmfAt: number | null; provider: string };
export function perTurn(bursts: Burst[], turns: any[], opts: { dtmfAt: number; syncDtmfAt: number; tolS?: number; lookBackS?: number }): HeardRow[];
export function formatTable(rows: HeardRow[], provider?: string): string;
