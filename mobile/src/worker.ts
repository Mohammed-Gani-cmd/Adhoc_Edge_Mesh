import { ApiError, checkCancelled, messageFor, wait } from './client.ts';
import type { Task } from './client.ts';
import { TaskFailure } from './activity.ts';
import type { Confirmation, Observe, StageSink, TaskStage } from './activity.ts';

export type WorkerIO = {
  register: () => Promise<string>;
  withdraw: (id: string) => Promise<void>;
  next: (id: string, signal: AbortSignal) => Promise<Task | null>;
  heartbeat: (id: string, signal: AbortSignal) => Promise<void>;
  process: (id: string, task: Task, signal: AbortSignal, progress?: StageSink) => Promise<void>;
  fail: (id: string, task: Task, error: string, signal: AbortSignal) => Promise<void | boolean>;
  reconcile?: (id: string, task: Task, signal: AbortSignal) => Promise<Confirmation>;
};

// Each instance owns exactly one registration, poll loop, and heartbeat loop.
// Stop waits for registration/withdrawal before callers can create its successor.
export class WorkerSession {
  controller = new AbortController();
  id = '';
  private registration: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private io: WorkerIO;
  private notify: (message: string) => void;
  private changed: (id: string, stopping?: boolean) => void;
  private pollMs: number;
  private heartbeatMs: number;
  private observe: Observe;
  private activeTask: Task | null = null;
  private activeStage: TaskStage = 'downloading';

  constructor(io: WorkerIO, notify: (message: string) => void, changed: (id: string, stopping?: boolean) => void, pollMs = 800, heartbeatMs = 5000, observe: Observe = () => {}) {
    this.io = io;
    this.notify = notify;
    this.changed = changed;
    this.pollMs = pollMs;
    this.heartbeatMs = heartbeatMs;
    this.observe = observe;
  }

  start(): Promise<void> {
    if (this.registration) return this.registration;
    this.registration = (async () => {
      checkCancelled(this.controller.signal);
      // Don't cancel registration midway: obtain the ID so stop can withdraw it.
      this.id = await this.io.register();
      if (this.controller.signal.aborted) return;
      this.changed(this.id);
      this.notify('Phone worker online. Keep the app open.');
      void this.pollLoop();
      void this.heartbeatLoop();
    })();
    return this.registration;
  }

  stop(reason = 'Phone worker paused. Join again to resume.'): Promise<void> {
    if (this.stopping) return this.stopping;
    this.controller.abort();
    if (this.activeTask) this.emit(this.activeTask, 'cancelled', reason, this.activeStage);
    this.changed('', true);
    this.notify(reason);
    this.stopping = (async () => {
      await this.registration?.catch(() => {});
      if (this.id) {
        try { await this.io.withdraw(this.id); }
        catch (error) { this.notify(`${reason} Could not notify the coordinator: ${messageFor(error)} Its offline timeout will apply.`); }
      }
      this.changed('');
    })();
    return this.stopping;
  }

  private emit(task: Task, stage: TaskStage, error?: string, failedStage?: TaskStage) {
    this.activeStage = stage;
    this.observe({ kind: 'task', task, workerId: this.id, stage, at: Date.now(), error, failedStage });
  }

  private async handleFailure(task: Task, error: unknown) {
    const signal = this.controller.signal;
    const root = error instanceof TaskFailure ? error.original : error;
    const failedStage = error instanceof TaskFailure ? error.stage : this.activeStage;
    if (root instanceof ApiError && [401, 403].includes(root.status)) {
      this.emit(task, 'failed', messageFor(error), failedStage);
      throw root;
    }
    let outcome: Confirmation;
    if (error instanceof TaskFailure && error.uncertain) {
      this.emit(task, 'confirming', messageFor(error), failedStage);
      outcome = await this.io.reconcile?.(this.id, task, signal) ?? 'pending';
    } else {
      try {
        const reported = await this.io.fail(this.id, task, messageFor(error), signal);
        outcome = reported === false ? await this.io.reconcile?.(this.id, task, signal) ?? 'pending' : 'failed';
      } catch (reportError) {
        this.emit(task, 'pending', `${messageFor(error)} Could not confirm failure reporting: ${messageFor(reportError)}`, failedStage);
        throw reportError;
      }
    }
    checkCancelled(signal);
    this.emit(task, outcome, messageFor(error), failedStage);
    this.notify(outcome === 'accepted' ? `Coordinator confirmed ${task.filename}` : outcome === 'failed' ? 'Phone attempt failed. The coordinator can retry on another worker.' : 'Result confirmation pending. Check the related job for its final outcome.');
  }

  private async pollLoop() {
    const signal = this.controller.signal;
    try {
      while (!signal.aborted) {
        const task = await this.io.next(this.id, signal);
        checkCancelled(signal);
        if (task) {
          this.activeTask = task;
          this.emit(task, 'downloading');
          try {
            await this.io.process(this.id, task, signal, stage => { if (!signal.aborted) this.emit(task, stage); });
            checkCancelled(signal);
            this.emit(task, 'accepted');
            this.notify(`Processed ${task.filename}`);
          } catch (error) {
            checkCancelled(signal);
            await this.handleFailure(task, error);
          } finally {
            this.activeTask = null;
          }
        }
        await wait(this.pollMs, signal);
      }
    } catch (error) {
      if (!signal.aborted) void this.stop(messageFor(error));
    }
  }

  private async heartbeatLoop() {
    const signal = this.controller.signal;
    try {
      while (!signal.aborted) {
        await wait(this.heartbeatMs, signal);
        await this.io.heartbeat(this.id, signal);
      }
    } catch (error) {
      if (!signal.aborted) void this.stop(messageFor(error));
    }
  }
}
