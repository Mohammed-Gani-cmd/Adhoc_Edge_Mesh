import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, Client, s3ResultText } from '../src/client.ts';
import { confirmationFor, emptyActivity, jobProgress, outcomeText, TaskFailure, updateActivity } from '../src/activity.ts';
import { WorkerSession } from '../src/worker.ts';
import { processTask, workerIO } from '../src/transfers.ts';

const task = { task_id: 't1', filename: 'image.png', max_width: 60, max_height: 60, job_id: 'j1', item_id: '0' };
const base = 'http://laptop';
const signal = () => new AbortController().signal;
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
function job(status, attempts, location = 'mobile') {
  return { job_id: 'j1', status, max_width: 60, max_height: 60, created_at: 1,
    items: [{ id: '0', source_name: 'image.png', state: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'processing', attempts, execution_location: location, assigned_node: location === 'mobile' ? 'Phone' : 'Laptop-1' }] };
}
const completed = { node: 'Phone', node_id: 'phone', status: 'completed' };
const failed = { node: 'Phone', node_id: 'phone', status: 'failed', error: 'Upload interrupted' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Cloud result status distinguishes saved ZIPs from upload failures', () => {
  const result = job('completed', [completed]);
  result.s3_result = { status: 'pending' };
  assert.match(s3ResultText(result), /Saving results ZIP/);
  result.s3_result = { status: 'saved', bucket: 'staging', key: 'edge-mesh/tasks/results/j1/results.zip' };
  assert.equal(s3ResultText(result), 'Saved to s3://staging/edge-mesh/tasks/results/j1/results.zip');
  result.s3_result = { status: 'failed', error: 'Could not save results to S3; local ZIP remains available' };
  assert.match(s3ResultText(result), /local ZIP remains available/);
});
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate());
}
function fixture(overrides = {}) {
  let polls = 0;
  const events = [], failures = [];
  const io = {
    register: async () => 'phone', withdraw: async () => {}, heartbeat: async () => {},
    next: async () => ++polls === 1 ? task : null,
    process: async () => {},
    fail: async (_id, _task, error) => { failures.push(error); return true; },
    reconcile: async () => 'pending', ...overrides,
  };
  const session = new WorkerSession(io, () => {}, () => {}, 1, 10000, event => events.push(event));
  return { session, events, failures };
}
function native(overrides = {}) {
  const removed = [];
  return { removed, download: async () => 'input', dimensions: async () => ({ width: 120, height: 80 }), jpeg: async () => 'output', file: () => new Blob(['image'], { type: 'image/jpeg' }), remove: uri => removed.push(uri), ...overrides };
}

test('lost upload acknowledgement is reconciled as accepted without reporting failure', async () => {
  const { session, events, failures } = fixture({ process: async () => { throw new TaskFailure('uploading', new Error('connection lost')); }, reconcile: async () => 'accepted' });
  await session.start(); await until(() => events.some(e => e.stage === 'accepted')); await session.stop();
  assert.deepEqual(events.filter(e => e.kind === 'task').map(e => e.stage), ['downloading', 'confirming', 'accepted']);
  assert.equal(failures.length, 0);
});
test('an unconfirmed upload stays pending and is not counted as failed', async () => {
  const { session, events, failures } = fixture({ process: async () => { throw new TaskFailure('uploading', new Error('offline')); } });
  await session.start(); await until(() => events.some(e => e.stage === 'pending')); await session.stop();
  const state = events.reduce((state, event) => updateActivity(state, event, base), emptyActivity());
  assert.equal(state.accepted, 0); assert.equal(state.failed, 0); assert.equal(failures.length, 0);
  assert.equal(state.records[0].failedStage, 'uploading');
});
test('late-result conflicts reconcile without terminating the worker', async () => {
  let polls = 0;
  const { session, events, failures } = fixture({ next: async () => ++polls === 1 ? task : null, process: async () => { throw new TaskFailure('uploading', new ApiError('lease expired', 409)); }, reconcile: async () => 'failed' });
  await session.start(); await until(() => polls > 1); assert.equal(session.controller.signal.aborted, false); await session.stop();
  assert.ok(events.some(e => e.stage === 'failed')); assert.equal(failures.length, 0);
});
test('decode errors retain their stage and notify the coordinator', async () => {
  const { session, events, failures } = fixture({ process: async () => { throw new TaskFailure('resizing', new Error('unsupported image')); } });
  await session.start(); await until(() => events.some(e => e.stage === 'failed')); await session.stop();
  assert.match(failures[0], /Resizing image: unsupported image/);
  assert.equal(events.find(e => e.stage === 'failed').failedStage, 'resizing');
});
test('a late failure report uses coordinator confirmation instead of inventing failure', async () => {
  const { session, events } = fixture({ process: async () => { throw new Error('local error'); }, fail: async () => false, reconcile: async () => 'accepted' });
  await session.start(); await until(() => events.some(e => e.stage === 'accepted')); await session.stop();
  assert.ok(!events.some(e => e.stage === 'failed'));
});
test('authentication errors in uploads end the session rather than being reported as image failures', async () => {
  const { session, failures } = fixture({ process: async () => { throw new TaskFailure('uploading', new ApiError('token rejected', 401)); } });
  await session.start(); await until(() => session.controller.signal.aborted); await session.stop();
  assert.equal(failures.length, 0);
});
test('job success on the laptop never counts as successful phone processing', () => {
  const event = { kind: 'task', task, workerId: 'phone', stage: 'failed', failedStage: 'uploading', error: 'Upload failed', at: 1 };
  const state = updateActivity(emptyActivity(), event, base);
  const result = job('completed', [failed, { node: 'Laptop-1', node_id: 'local', status: 'completed' }], 'local');
  assert.equal(confirmationFor(result, task, 'phone'), 'failed');
  assert.equal(state.accepted, 0); assert.equal(state.failed, 1);
  assert.match(outcomeText(state.records[0], result), /Image completed on Laptop-1 after retry/);
  assert.equal(jobProgress(result).percent, 100);
  const otherPhone = job('completed', [failed, { node: 'Other phone', node_id: 'other-phone', status: 'completed' }]);
  otherPhone.items[0].assigned_node = 'Other phone';
  assert.match(outcomeText(state.records[0], otherPhone), /Image completed on Other phone after retry/);
});
test('matching phone attempt determines confirmation even when the overall job fails', () => {
  assert.equal(confirmationFor(job('failed', [completed]), task, 'phone'), 'accepted');
  assert.equal(confirmationFor(job('completed', [{ ...completed, node_id: 'other' }]), task, 'phone'), 'pending');
  assert.equal(confirmationFor(job('running', [{ ...completed, status: 'running' }]), task, 'phone'), 'pending');
});
test('activity counters deduplicate confirmation and keep errors available', () => {
  const event = { kind: 'task', task, workerId: 'phone', stage: 'pending', error: 'ack lost', at: 1 };
  let state = updateActivity(emptyActivity(), event, base);
  state = updateActivity(state, { ...event, stage: 'accepted', at: 2 }, base);
  state = updateActivity(state, { ...event, stage: 'accepted', at: 3 }, base);
  assert.equal(state.accepted, 1); assert.equal(state.records.length, 1); assert.equal(state.records[0].startedAt, 1); assert.equal(state.records[0].error, 'ack lost');
  state = updateActivity(state, { ...event, stage: 'pending', at: 4 }, base);
  state = updateActivity(state, { ...event, stage: 'cancelled', at: 5 }, base);
  assert.equal(state.accepted, 1); assert.equal(state.records[0].stage, 'accepted');
});
test('history retains 20 recent attempts while counters retain the app-session totals', () => {
  let state = emptyActivity();
  for (let index = 0; index < 25; index++) state = updateActivity(state, { kind: 'task', task: { ...task, task_id: String(index) }, workerId: 'phone', stage: 'accepted', at: index }, base);
  assert.equal(state.records.length, 20); assert.equal(state.accepted, 25); assert.equal(state.records[0].task.task_id, '24');
});
test('job progress separates failed images from active processing', () => {
  const result = job('running', []);
  result.items = [{ state: 'completed' }, { state: 'failed' }, { state: 'retrying' }, { state: 'queued' }];
  assert.deepEqual(jobProgress(result), { completed: 1, failed: 1, processing: 1, total: 4, percent: 25 });
});
test('worker transfer reports stages and preserves real multipart bytes', async () => {
  const stages = [], io = native();
  const client = new Client(base, 'shared', async (_url, options) => {
    assert.equal(await options.body.get('image').text(), 'image');
    assert.equal(options.headers['X-Edge-Token'], 'shared');
    assert.equal(options.headers['Content-Type'], undefined, 'fetch must set its multipart boundary');
    return response({ status: 'accepted' });
  });
  await processTask(client, io, 'phone', task, signal(), stage => stages.push(stage));
  assert.deepEqual(stages, ['downloading', 'resizing', 'uploading']); assert.deepEqual(io.removed, ['input', 'output']);
});
test('upload interruption is uncertain; explicit rejection is a stage-specific failure', async () => {
  for (const [fetcher, uncertain] of [[async () => { throw new Error('network failed'); }, true], [async () => response({ error: 'invalid image' }, 400), false]]) {
    const io = native();
    await assert.rejects(processTask(new Client(base, '', fetcher), io, 'phone', task, signal()), error => error instanceof TaskFailure && error.stage === 'uploading' && error.uncertain === uncertain);
    assert.deepEqual(io.removed, ['input', 'output']);
  }
});
test('cancellation after native rendering cleans files and suppresses upload', async () => {
  const controller = new AbortController(), io = native({ jpeg: async () => { controller.abort(); return 'output'; } });
  const client = new Client(base, '', async () => { assert.fail('must not upload'); });
  await assert.rejects(processTask(client, io, 'phone', task, controller.signal), /cancelled/);
  assert.deepEqual(io.removed, ['input', 'output']);
});
test('HTTP reconciliation reads the linked job and treats expired fail reports as benign', async () => {
  const client = new Client(base, 'shared', async url => url.endsWith('/fail') ? response({ error: 'gone' }, 404) : response(job('completed', [completed])));
  const io = workerIO(client, native(), async () => ({}));
  assert.equal(await io.reconcile('phone', task, signal()), 'accepted');
  assert.equal(await io.fail('phone', task, 'late', signal()), false);
});
test('unreachable reconciliation keeps confirmation pending; old task payloads remain supported', async () => {
  const client = new Client(base, '', async () => { throw new Error('offline'); });
  const io = workerIO(client, native(), async () => ({}));
  assert.equal(await io.reconcile('phone', task, signal()), 'pending');
  assert.equal(await io.reconcile('phone', { ...task, job_id: undefined }, signal()), 'pending');
});
