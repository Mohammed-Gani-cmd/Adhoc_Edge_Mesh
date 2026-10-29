import { ApiError, messageFor } from './client.ts';
import type { Job, Task } from './client.ts';

export type TaskStage = 'downloading' | 'resizing' | 'uploading' | 'confirming' | 'accepted' | 'pending' | 'failed' | 'cancelled';
export type TaskEvent = { kind: 'task'; task: Task; workerId: string; stage: TaskStage; at: number; error?: string; failedStage?: TaskStage };
export type WorkerEvent = TaskEvent | { kind: 'contact'; at: number; rttMs?: number } | { kind: 'device'; name: string; platform: string; memoryMb: number; estimatedFreeMb: number };
export type Observe = (event: WorkerEvent) => void;
export type StageSink = (stage: TaskStage) => void;
export type Confirmation = 'accepted' | 'failed' | 'pending';

export class TaskFailure extends Error {
  stage: TaskStage;
  original: unknown;
  uncertain: boolean;
  constructor(stage: TaskStage, error: unknown) {
    super(`${stageLabel(stage)}: ${messageFor(error)}`);
    this.stage = stage;
    this.original = error;
    // An absent upload acknowledgement doesn't prove the server rejected the file.
    this.uncertain = stage === 'uploading' && (!(error instanceof ApiError) || [404, 409].includes(error.status));
  }
}

export function stageLabel(stage: TaskStage) {
  return ({ downloading: 'Downloading input', resizing: 'Resizing image', uploading: 'Uploading result', confirming: 'Awaiting confirmation', accepted: 'Accepted by coordinator', pending: 'Confirmation pending', failed: 'Phone attempt failed', cancelled: 'Phone attempt paused' })[stage];
}

export function confirmationFor(job: Job, task: Task, workerId: string): Confirmation {
  const item = job.items.find(item => item.id === task.item_id);
  const attempt = item?.attempts?.find(attempt => attempt.node_id === workerId);
  if (attempt?.status === 'completed') return 'accepted';
  if (attempt?.status === 'failed') return 'failed';
  return 'pending';
}

export type ActivityRecord = TaskEvent & { base: string; startedAt: number };
export type ActivityState = { records: ActivityRecord[]; accepted: number; failed: number };
export const emptyActivity = (): ActivityState => ({ records: [], accepted: 0, failed: 0 });

export function updateActivity(state: ActivityState, event: TaskEvent, base: string): ActivityState {
  const previous = state.records.find(record => record.base === base && record.task.task_id === event.task.task_id);
  // A delayed poll or cancellation must not erase a confirmed terminal outcome.
  if (previous && ['accepted', 'failed'].includes(previous.stage) && !['accepted', 'failed'].includes(event.stage)) return state;
  // Keep errors attached to the attempt even after a delayed acknowledgement resolves.
  const record: ActivityRecord = { ...previous, ...event, base, startedAt: previous?.startedAt ?? event.at };
  return {
    records: [record, ...state.records.filter(row => row !== previous)].sort((a, b) => b.at - a.at).slice(0, 20),
    accepted: state.accepted + Number(event.stage === 'accepted') - Number(previous?.stage === 'accepted'),
    failed: state.failed + Number(event.stage === 'failed') - Number(previous?.stage === 'failed'),
  };
}

export function jobProgress(job: Job) {
  const completed = job.items.filter(item => item.state === 'completed').length;
  const failed = job.items.filter(item => item.state === 'failed').length;
  const processing = job.items.filter(item => ['processing', 'retrying'].includes(item.state)).length;
  return { completed, failed, processing, total: job.items.length, percent: job.items.length ? Math.round(completed / job.items.length * 100) : 0 };
}

export function outcomeText(record: ActivityRecord, job?: Job) {
  if (!job) return record.task.job_id ? 'Waiting for job status' : 'Job details need an updated coordinator';
  const item = job.items.find(item => item.id === record.task.item_id);
  const completedBy = item?.attempts.find(attempt => attempt.status === 'completed')?.node_id;
  if (item?.state === 'completed' && completedBy && completedBy !== record.workerId && record.stage === 'failed') {
    return `Image completed on ${item.assigned_node || 'another worker'} after retry`;
  }
  if (job.status === 'completed') return 'Overall job completed';
  if (job.status === 'failed') return 'Overall job failed — see job details';
  if (item?.state === 'retrying' || record.stage === 'failed') return 'Coordinator can retry on another worker';
  return 'Overall job in progress';
}

export function durationText(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
