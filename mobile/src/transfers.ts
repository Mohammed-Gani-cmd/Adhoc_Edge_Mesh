import { ApiError, checkCancelled, jsonBody, wait, withDeadline } from './client.ts';
import type { Client, Job, Task } from './client.ts';
import type { WorkerIO } from './worker.ts';
import { confirmationFor, TaskFailure } from './activity.ts';
import type { Observe, StageSink, TaskStage } from './activity.ts';

export const MAX_IMAGES = 100;
export const MAX_BYTES = 100 * 1024 * 1024;
export type Asset = { uri: string; fileSize?: number };
export type NativeIO = {
  pick: () => Promise<Asset[] | null>;
  jpeg: (uri: string, size?: { width: number; height: number }) => Promise<string>;
  size: (uri: string) => number;
  file: (uri: string) => Blob;
  dimensions: (uri: string) => Promise<{ width: number; height: number }>;
  remove: (uri: string) => void;
  download: (url: string, filename: string, headers: Record<string, string>, signal: AbortSignal) => Promise<string>;
  sharingAvailable: () => Promise<boolean>;
  share: (uri: string) => Promise<void>;
};

function clean(io: NativeIO, uri: string) { try { io.remove(uri); } catch {} }
function attach(body: FormData, io: NativeIO, field: string, uri: string, name: string) {
  // Expo fetch serializes an actual native File/Blob, including its bytes.
  body.append(field, io.file(uri), name);
}

export async function submitImages(client: Client, io: NativeIO, signal: AbortSignal): Promise<Job | null> {
  const temporary: string[] = [];
  try {
    const assets = await io.pick();
    checkCancelled(signal);
    if (!assets?.length) return null;
    if (assets.length > MAX_IMAGES) throw new Error(`Choose at most ${MAX_IMAGES} images.`);
    if (assets.reduce((sum, asset) => sum + (asset.fileSize || 0), 0) > MAX_BYTES) throw new Error('Selected images exceed the 100 MB upload limit. Choose a smaller batch.');
    const body = new FormData();
    let bytes = 0;
    for (const [index, asset] of assets.entries()) {
      checkCancelled(signal);
      const uri = await io.jpeg(asset.uri);
      temporary.push(uri);
      checkCancelled(signal);
      bytes += io.size(uri);
      if (bytes > MAX_BYTES) throw new Error('Converted images exceed the 100 MB upload limit. Choose a smaller batch.');
      attach(body, io, 'images', uri, `mobile-${index}.jpg`);
    }
    body.append('max_width', '1280');
    body.append('max_height', '720');
    body.append('submitted_from', 'mobile');
    return await client.json<Job>('/api/v1/jobs', { method: 'POST', body }, signal, 45000);
  } finally { temporary.forEach(uri => clean(io, uri)); }
}

export function resizedDimensions(width: number, height: number, maxWidth: number, maxHeight: number) {
  if (![width, height, maxWidth, maxHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid image dimensions.');
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function processTask(client: Client, io: NativeIO, id: string, task: Task, signal: AbortSignal, progress: StageSink = () => {}) {
  let input: string | undefined;
  let output: string | undefined;
  const started = Date.now();
  let stage: TaskStage = 'downloading';
  const report = (next: TaskStage) => { stage = next; progress(next); };
  try {
    report('downloading');
    input = await withDeadline(bounded => io.download(
      `${client.base}/api/v1/mobile/workers/${id}/tasks/${task.task_id}/input`,
      `${task.task_id}-input`, client.headers, bounded,
    ), signal, 30000);
    checkCancelled(signal);
    report('resizing');
    const size = await io.dimensions(input);
    output = await io.jpeg(input, resizedDimensions(size.width, size.height, task.max_width, task.max_height));
    checkCancelled(signal);
    report('uploading');
    const body = new FormData();
    body.append('processing_ms', String(Date.now() - started));
    attach(body, io, 'image', output, task.filename.replace(/\.[^.]+$/, '') + '.jpg');
    await client.json(`/api/v1/mobile/workers/${id}/tasks/${task.task_id}/result`, { method: 'POST', body }, signal, 20000);
  } catch (error) {
    throw new TaskFailure(stage, error);
  } finally {
    if (input) clean(io, input);
    if (output) clean(io, output);
  }
}

export function workerIO(client: Client, io: NativeIO, metadata: () => Promise<Record<string, unknown>>, observe: Observe = () => {}): WorkerIO {
  let metrics: Record<string, unknown> = {};
  let rtt = 5;
  return {
    async register() {
      if (!client.token.trim()) throw new Error('Enter the shared worker token.');
      await client.check();
      metrics = await metadata();
      observe({ kind: 'device', name: String(metrics.name || 'This phone'), platform: String(metrics.platform || 'mobile'), memoryMb: Number(metrics.total_memory_mb || 0), estimatedFreeMb: Number(metrics.free_memory_mb || 0) });
      const result = await client.json<{ worker_id: string; protocol_version: string }>('/api/v1/mobile/workers/register', jsonBody(metrics));
      if (!result.worker_id) throw new Error('The coordinator did not return a worker ID.');
      return result.worker_id;
    },
    async withdraw(id) { await client.request(`/api/v1/mobile/workers/${id}`, { method: 'DELETE' }); },
    async next(id, signal) {
      const started = Date.now();
      const query = new URLSearchParams({ cpu_percent: '0', total_memory_mb: String(metrics.total_memory_mb), free_memory_mb: String(metrics.free_memory_mb), rtt_ms: String(rtt) });
      const task = await client.request<Task>(`/api/v1/mobile/workers/${id}/tasks/next?${query}`, {}, signal);
      rtt = Date.now() - started;
      observe({ kind: 'contact', at: Date.now(), rttMs: rtt });
      return task;
    },
    async heartbeat(id, signal) {
      await client.json(`/api/v1/mobile/workers/${id}/heartbeat`, jsonBody({ ...metrics, rtt_ms: rtt }), signal);
      observe({ kind: 'contact', at: Date.now() });
    },
    process: (id, task, signal, progress) => processTask(client, io, id, task, signal, progress),
    async fail(id, task, error, signal) {
      try { await client.json(`/api/v1/mobile/workers/${id}/tasks/${task.task_id}/fail`, jsonBody({ error }), signal); }
      catch (error) {
        // The lease may already have ended or its result may already be accepted.
        if (error instanceof ApiError && [404, 409].includes(error.status)) return false;
        throw error;
      }
      return true;
    },
    async reconcile(id, task, signal) {
      if (!task.job_id || task.item_id == null) return 'pending';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const job = await client.json<Job>(`/api/v1/jobs/${task.job_id}`, {}, signal, 3000);
          const confirmation = confirmationFor(job, task, id);
          if (confirmation !== 'pending') return confirmation;
        } catch (error) {
          checkCancelled(signal);
          if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
          return 'pending';
        }
        if (attempt < 2) await wait(350, signal);
      }
      return 'pending';
    },
  };
}

export class ResultDownloads {
  private previous: string | undefined;
  private io: NativeIO;
  constructor(io: NativeIO) { this.io = io; }
  async share(client: Client, jobId: string, signal: AbortSignal) {
    if (!await this.io.sharingAvailable()) throw new Error('File sharing is unavailable on this device.');
    this.clear();
    const uri = await withDeadline(bounded => this.io.download(
      `${client.base}/api/v1/jobs/${jobId}/download`, `${jobId}-results.zip`, client.headers, bounded,
    ), signal, 45000);
    this.previous = uri;
    try { checkCancelled(signal); await this.io.share(uri); }
    catch (error) { this.clear(); throw error; }
    // Keep the file until the next download/unmount; Android share targets may read it later.
  }
  clear() { if (this.previous) clean(this.io, this.previous); this.previous = undefined; }
}
