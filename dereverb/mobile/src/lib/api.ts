/**
 * api.ts
 * ======
 *
 * Typed client for the EchoStrip FastAPI backend.
 *
 * Every request carries the anonymous `X-Device-Id` header, which is how the
 * server scopes History without accounts.
 *
 * Configure the backend with `EXPO_PUBLIC_API_URL`. The default only works in
 * a simulator or on web; a physical device must point at your machine's LAN
 * address (for example `EXPO_PUBLIC_API_URL=http://192.168.1.20:8000`), because
 * `localhost` on a phone is the phone itself.
 */
import { getDeviceId } from './device';

export const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000').replace(
  /\/+$/,
  '',
);

/** Extensions the backend accepts; mirrored here for instant client feedback. */
export const ACCEPTED_EXTENSIONS = ['.wav', '.mp3', '.m4a'] as const;

/** Upload ceiling in bytes, kept in step with the server's 25 MB limit. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type JobStatus = 'done' | 'failed';

export interface JobUrls {
  original: string;
  cleaned: string;
  download: string;
}

export interface JobSummary {
  job_id: string;
  created_at: number;
  status: JobStatus;
  original_name: string;
  duration_seconds: number | null;
  size_bytes: number | null;
  engine: string | null;
  error: string | null;
  /** False once the retention sweep has removed the audio. */
  files_available: boolean;
  urls: JobUrls;
}

export interface Benchmark {
  audio_seconds: number;
  decode_seconds: number;
  enhance_seconds: number;
  postprocess_seconds: number;
  encode_seconds: number;
  total_seconds: number;
  speed_ratio: number;
  enhance_speed_ratio: number;
}

export interface MatrixRow {
  key: string;
  tool: string;
  category: string;
  is_self: boolean;
  measured: boolean;
  speed_label: string;
  machine_time: string;
  operator_time: string;
  manual_controls: string;
  delivery: string;
  price: string;
  api_or_batch: string;
}

export interface ComparisonMatrix {
  rows: MatrixRow[];
  notes: string[];
  edge: {
    speed_multiple: number;
    speed_headline: string;
    round_trip_saved: string;
    workflow_headline: string;
  };
}

export interface UploadResult {
  job_id: string;
  engine: string;
  original: {
    filename: string;
    size_bytes: number;
    size_mb: number;
    duration_seconds: number;
    sample_rate: number;
    channels: number;
    url: string;
  };
  cleaned: {
    size_mb: number;
    sample_rate: number;
    channels: number;
    url: string;
    download_url: string;
  };
  benchmark: Benchmark;
  matrix: ComparisonMatrix;
  warnings: string[];
}

export interface JobDetail extends JobSummary {
  payload: UploadResult | null;
}

export interface HistoryPage {
  jobs: JobSummary[];
  total: number;
  limit: number;
  offset: number;
  retention_minutes: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  engine: { available: boolean; name: string | null; detail: string };
  limits: {
    max_upload_mb: number;
    max_concurrent_jobs: number;
    retention_minutes: number;
    accepted_extensions: string[];
  };
}

/** A file chosen by the user, normalised across the native and web pickers. */
export interface PickedAudio {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
  /** Present on web, where FormData needs a real Blob rather than a URI. */
  file?: File;
}

/** Error carrying the server's user-facing message plus its status code. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Turn any backend error body into a message that is safe to display. */
async function toApiError(response: Response): Promise<ApiError> {
  let message = `Request failed (HTTP ${response.status}).`;
  try {
    const body = await response.json();
    if (typeof body?.detail === 'string') {
      message = body.detail;
    } else if (Array.isArray(body?.detail) && body.detail[0]?.msg) {
      message = body.detail[0].msg;
    }
  } catch {
    // Non-JSON body (a proxy error page, say): keep the generic message.
  }
  return new ApiError(message, response.status);
}

async function deviceHeaders(): Promise<Record<string, string>> {
  return { 'X-Device-Id': await getDeviceId() };
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(await deviceHeaders()), ...(init.headers ?? {}) },
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

/** Absolute URL for a path the API returned relative. */
export function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${API_BASE}${path}`;
}

/** Server health, including whether the de-reverb engine is actually loaded. */
export async function fetchHealth(): Promise<HealthReport> {
  return requestJson<HealthReport>('/healthz');
}

/** Newest-first History page for this device. */
export async function fetchHistory(limit = 50, offset = 0): Promise<HistoryPage> {
  return requestJson<HistoryPage>(`/api/jobs?limit=${limit}&offset=${offset}`);
}

/** One job, including the full result payload when it succeeded. */
export async function fetchJob(jobId: string): Promise<JobDetail> {
  return requestJson<JobDetail>(`/api/jobs/${jobId}`);
}

/** Remove one job and its audio. */
export async function deleteJob(jobId: string): Promise<void> {
  await requestJson<{ deleted: string }>(`/api/jobs/${jobId}`, { method: 'DELETE' });
}

/** Remove every job for this device. */
export async function clearHistory(): Promise<number> {
  const body = await requestJson<{ deleted: number }>('/api/jobs', { method: 'DELETE' });
  return body.deleted;
}

/**
 * Upload and process one file.
 *
 * Uses `XMLHttpRequest` rather than `fetch` because only XHR exposes upload
 * progress, which the Create screen needs for its determinate progress bar.
 * The returned promise settles only once the server has finished processing,
 * so the caller shows rotating status copy while awaiting it.
 *
 * @param onProgress receives 0..1 for the transfer leg only.
 * @returns an abort function alongside the promise, so leaving the screen
 *          cancels the request instead of leaking it.
 */
export function uploadAudio(
  audio: PickedAudio,
  onProgress?: (fraction: number) => void,
): { promise: Promise<UploadResult>; abort: () => void } {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<UploadResult>((resolve, reject) => {
    deviceHeaders()
      .then((headers) => {
        const form = new FormData();
        if (audio.file) {
          // Web: the picker hands back a real File object.
          form.append('file', audio.file, audio.name);
        } else {
          // Native: React Native's FormData accepts a file descriptor.
          form.append('file', {
            uri: audio.uri,
            name: audio.name,
            type: audio.mimeType ?? 'application/octet-stream',
          } as unknown as Blob);
        }

        xhr.open('POST', `${API_BASE}/upload`, true);
        Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));

        if (onProgress && xhr.upload) {
          xhr.upload.onprogress = (event: ProgressEvent) => {
            if (event.lengthComputable && event.total > 0) {
              onProgress(event.loaded / event.total);
            }
          };
        }

        xhr.onload = () => {
          let body: any = null;
          try {
            body = typeof xhr.response === 'object' && xhr.response !== null
              ? xhr.response
              : JSON.parse(xhr.responseText || '{}');
          } catch {
            body = null;
          }
          if (xhr.status >= 200 && xhr.status < 300 && body?.job_id) {
            resolve(body as UploadResult);
            return;
          }
          const detail =
            typeof body?.detail === 'string'
              ? body.detail
              : Array.isArray(body?.detail) && body.detail[0]?.msg
                ? body.detail[0].msg
                : `Processing failed (HTTP ${xhr.status}).`;
          reject(new ApiError(detail, xhr.status));
        };

        xhr.onerror = () =>
          reject(new ApiError('Could not reach the server. Check your connection.', 0));
        xhr.ontimeout = () =>
          reject(new ApiError('The server took too long to respond.', 0));
        xhr.onabort = () => reject(new ApiError('Upload cancelled.', 0));

        xhr.send(form);
      })
      .catch(reject);
  });

  return { promise, abort: () => xhr.abort() };
}

/** Client-side validation mirroring the server, for instant feedback. */
export function validateAudio(audio: PickedAudio): string | null {
  const dot = audio.name.lastIndexOf('.');
  const extension = dot === -1 ? '' : audio.name.slice(dot).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number])) {
    return `Unsupported file type "${extension || 'unknown'}". Use ${ACCEPTED_EXTENSIONS.join(', ')}.`;
  }
  if (audio.size != null && audio.size > MAX_UPLOAD_BYTES) {
    return `That file is ${(audio.size / (1024 * 1024)).toFixed(1)} MB. The limit is 25 MB.`;
  }
  if (audio.size === 0) return 'That file is empty.';
  return null;
}
