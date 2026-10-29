export const PROTOCOL_VERSION = "1.1";

export type Task = { task_id: string; filename: string; max_width: number; max_height: number; job_id?: string; item_id?: string };
export type Attempt = { node: string; node_id: string; location?: string; status: string; duration_ms?: number; error?: string | null };
export type JobItem = {
  id: string; source_name: string; state: string; attempts: Attempt[];
  assigned_node?: string | null; execution_location?: string | null;
  output_size?: number[] | null; processing_ms?: number | null; error?: string | null;
};
export type Job = {
  job_id: string;
  status: string;
  submitted_from?: 'mobile' | 'web' | 'unknown';
  items: JobItem[];
  max_width: number; max_height: number; created_at: number; duration?: number | null;
  node_contributions?: Record<string, number>;
  error?: string | null;
  s3_result?: { status: 'pending' | 'uploading' | 'saved' | 'failed' | 'skipped'; bucket?: string | null; key?: string | null; error?: string | null } | null;
};

export function s3ResultText(job: Job): string | undefined {
  const result = job.s3_result;
  if (!result) return undefined;
  if (result.status === 'saved') return `Saved to s3://${result.bucket}/${result.key}`;
  if (result.status === 'failed' || result.status === 'skipped') return result.error || 'S3 results unavailable.';
  return 'Saving results ZIP to S3…';
}

export type Transport = (url: string, options?: RequestInit) => Promise<Pick<Response, 'status' | 'ok' | 'json'>>;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function coordinatorUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Enter the laptop LAN URL, for example http://192.168.1.10:5000."); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error("Use an HTTP or HTTPS coordinator URL without a path, password, or query.");
  }
  if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname)) {
    throw new Error("Use the laptop's LAN IP address. Localhost refers to this phone.");
  }
  return url.origin;
}

export function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed. Please try again.";
}

export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Operation cancelled.");
}

// A deadline also settles requests whose underlying implementation ignores abort.
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  timeoutMs = 10000,
): Promise<T> {
  checkCancelled(parent);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => { reject(new Error("Operation cancelled.")); controller.abort(); };
    parent?.addEventListener('abort', cancel, { once: true });
    timeout = setTimeout(() => {
      reject(new Error("Coordinator request timed out. Check Wi-Fi and the laptop address, then try again."));
      controller.abort();
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), interrupted]); }
  finally {
    clearTimeout(timeout);
    parent?.removeEventListener('abort', cancel);
  }
}

export class Client {
  base: string;
  token: string;
  fetcher: Transport;
  constructor(url: string, token: string, fetcher: Transport = fetch) {
    this.base = coordinatorUrl(url);
    this.token = token;
    this.fetcher = fetcher;
  }
  get headers() { return { 'X-Edge-Token': this.token }; }

  async request<T>(path: string, options: RequestInit = {}, signal?: AbortSignal, timeoutMs = 10000): Promise<T | null> {
    return withDeadline(async boundedSignal => {
      let response: Pick<Response, 'status' | 'ok' | 'json'>;
      try {
        response = await this.fetcher(this.base + path, {
          ...options, headers: { ...this.headers, ...options.headers }, signal: boundedSignal,
        });
      } catch (error) {
        if (boundedSignal.aborted) throw error;
        throw new Error(`Cannot reach the coordinator: ${messageFor(error)} Check Wi-Fi, local-network permission, and the laptop address.`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ApiError("Worker token rejected. Enter the same token used to start the coordinator.", response.status);
      }
      if (response.status === 404) throw new ApiError("Worker session or job no longer exists. The coordinator may have restarted; join again or submit a new job.", 404);
      if (response.status === 204) return null;
      let data;
      try { data = await response.json(); }
      catch { throw new Error(`The coordinator returned an invalid response (${response.status}). Check the URL and server version.`); }
      if (!response.ok) throw new ApiError(data.error || `Coordinator request failed (${response.status}).`, response.status);
      return data as T;
    }, signal, timeoutMs);
  }

  async json<T>(path: string, options: RequestInit = {}, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const result = await this.request<T>(path, options, signal, timeoutMs);
    if (result === null) throw new Error("The coordinator returned an empty response.");
    return result;
  }

  async check(signal?: AbortSignal) {
    const status = await this.json<{ protocol_version: string; display_name: string }>('/api/v1/status', {}, signal);
    if (status.protocol_version !== PROTOCOL_VERSION) throw new Error(`Unsupported coordinator protocol. This app needs ${PROTOCOL_VERSION}; update the coordinator and phone app together.`);
    return status;
  }
}

export function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function terminalJob(job: Job) { return job.status === 'completed' || job.status === 'failed'; }

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error('Operation cancelled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
