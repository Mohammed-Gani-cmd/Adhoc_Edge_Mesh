import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, coordinatorUrl, jsonBody, terminalJob, withDeadline } from '../src/client.ts';
import { WorkerSession } from '../src/worker.ts';
import { MAX_BYTES, ResultDownloads, processTask, resizedDimensions, submitImages, workerIO } from '../src/transfers.ts';
import './dashboard.test.mjs';

const signal = () => new AbortController().signal;
const response = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const job = { job_id: 'abc123', status: 'running', items: [] };
const task = { task_id: 'task123', filename: 'sample.png', max_width: 60, max_height: 60 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate(), 'condition did not become true');
}
function native(overrides = {}) {
  const removed = [], shared = [], downloads = [];
  return {
    removed, shared, downloads,
    pick: async () => [{ uri: 'source' }], jpeg: async uri => uri + '.jpg', size: () => 100,
    file: () => new Blob(['native-image-bytes'], { type: 'image/jpeg' }),
    dimensions: async () => ({ width: 120, height: 80 }), remove: uri => removed.push(uri),
    download: async (...args) => { downloads.push(args); return 'cache/' + args[1]; },
    sharingAvailable: async () => true, share: async uri => { shared.push(uri); }, ...overrides,
  };
}
function worker(overrides = {}) {
  const calls = { register: 0, withdraw: [], polls: 0, heartbeats: 0, processed: 0, failed: [] };
  const messages = [], states = [];
  const io = {
    register: async () => { calls.register++; return 'phone'; }, withdraw: async id => { calls.withdraw.push(id); },
    next: async () => { calls.polls++; return null; }, heartbeat: async () => { calls.heartbeats++; },
    process: async () => { calls.processed++; }, fail: async (_id, _task, error) => { calls.failed.push(error); }, ...overrides,
  };
  return { session: new WorkerSession(io, text => messages.push(text), (...state) => states.push(state), 2, 2), calls, messages, states };
}

test('URL normalization and rejection of invalid addresses and phone loopback', () => {
  assert.equal(coordinatorUrl(' http://192.168.1.10:5000/ '), 'http://192.168.1.10:5000');
  assert.equal(coordinatorUrl('https://laptop.local:5000'), 'https://laptop.local:5000');
  for (const url of ['laptop', 'ftp://laptop', 'http://localhost:5000', 'http://127.0.0.1', 'http://laptop/api', 'http://user:pass@laptop', 'http://laptop?token=x']) assert.throws(() => coordinatorUrl(url));
});
test('connection requires the supported coordinator protocol', async () => {
  await assert.rejects(new Client('http://laptop', '', async () => response({ protocol_version: '0.1' })).check(), /Unsupported coordinator protocol/);
  assert.equal((await new Client('http://laptop', '', async () => response({ protocol_version: '1.1', display_name: 'Laptop' })).check()).display_name, 'Laptop');
});
test('request surfaces authentication, expired sessions, server errors, and invalid JSON', async () => {
  for (const [status, pattern] of [[401, /token rejected/], [403, /token rejected/], [404, /no longer exists/], [500, /server problem/]]) {
    await assert.rejects(new Client('http://laptop', 'wrong', async () => response({ error: 'server problem' }, status)).json('/test'), pattern);
  }
  await assert.rejects(new Client('http://laptop', '', async () => new Response('<html>bad</html>')).json('/test'), /invalid response/);
  await assert.rejects(new Client('http://laptop', '', async () => { throw new TypeError('network'); }).json('/test'), /Cannot reach the coordinator/);
});
test('request preserves token, JSON body, and idle responses', async () => {
  const client = new Client('http://laptop', 'shared', async (url, options) => {
    assert.equal(url, 'http://laptop/test');
    assert.equal(options.headers['X-Edge-Token'], 'shared');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.body, '{"name":"Phone"}');
    return response(null, 204);
  });
  assert.equal(await client.request('/test', jsonBody({ name: 'Phone' })), null);
});
test('deadline aborts hung operations; parent cancellation settles promptly', async () => {
  let bounded;
  await assert.rejects(withDeadline(async s => { bounded = s; return new Promise(() => {}); }, undefined, 5), /timed out/);
  assert.equal(bounded.aborted, true);
  const controller = new AbortController();
  const pending = withDeadline(async () => new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});
test('duplicate starts and stops register and withdraw exactly once', async () => {
  const { session, calls } = worker();
  await Promise.all([session.start(), session.start()]);
  await until(() => calls.heartbeats > 0);
  await Promise.all([session.stop(), session.stop()]);
  const polls = calls.polls, heartbeats = calls.heartbeats;
  await tick();
  assert.equal(calls.register, 1);
  assert.deepEqual(calls.withdraw, ['phone']);
  assert.equal(calls.polls, polls);
  assert.equal(calls.heartbeats, heartbeats);
});
test('pause during registration withdraws the eventual ID without polling', async () => {
  const pending = deferred();
  const { session, calls, states } = worker({ register: () => pending.promise });
  const starting = session.start(), stopping = session.stop('backgrounded');
  pending.resolve('late-phone');
  await Promise.all([starting, stopping]);
  assert.deepEqual(calls.withdraw, ['late-phone']);
  assert.equal(calls.polls, 0);
  assert.ok(!states.some(([id]) => id));
});
test('stopped sessions stay stopped; a new session can rejoin', async () => {
  const first = worker();
  await first.session.start(); await first.session.stop(); await first.session.start();
  assert.equal(first.calls.register, 1);
  const second = worker();
  await second.session.start(); await second.session.stop();
  assert.equal(second.calls.register, 1);
});
test('registration failure has no unhandled poll or heartbeat', async () => {
  const { session, calls } = worker({ register: async () => { throw new Error('wrong token'); } });
  await assert.rejects(session.start(), /wrong token/); await session.stop();
  assert.equal(calls.polls, 0); assert.equal(calls.heartbeats, 0);
});
test('authentication and expired polling sessions stop worker activity', async () => {
  for (const reason of ['Worker token rejected', 'Worker session no longer exists']) {
    const { session, calls, messages } = worker({ next: async () => { throw new Error(reason); } });
    await session.start(); await until(() => calls.withdraw.length > 0); await session.stop();
    assert.ok(messages.includes(reason));
  }
});
test('heartbeat connection failure stops and withdraws the worker', async () => {
  const { session, calls, messages } = worker({ heartbeat: async () => { throw new Error('Wi-Fi disconnected'); } });
  await session.start(); await until(() => calls.withdraw.length > 0); await session.stop();
  assert.ok(messages.includes('Wi-Fi disconnected'));
});
test('pause aborts an in-flight task and suppresses stale success or failure', async () => {
  const processing = deferred(); let taskSignal;
  const { session, calls, messages } = worker({ next: async () => task, process: async (_id, _task, s) => { taskSignal = s; await processing.promise; } });
  await session.start(); await until(() => !!taskSignal); await session.stop('paused');
  assert.equal(taskSignal.aborted, true); processing.resolve(); await tick();
  assert.equal(calls.failed.length, 0); assert.ok(!messages.some(text => text.startsWith('Processed')));
});
test('task errors are reported and polling continues', async () => {
  let polls = 0;
  const { session, calls } = worker({ next: async () => ++polls === 1 ? task : null, process: async () => { throw new Error('bad image'); } });
  await session.start(); await until(() => polls >= 2); await session.stop();
  assert.deepEqual(calls.failed, ['bad image']);
});
test('withdrawal failure is visible and still finishes session cleanup', async () => {
  const { session, states, messages } = worker({ withdraw: async () => { throw new Error('offline'); } });
  await session.start(); await session.stop();
  assert.deepEqual(states.at(-1), ['']); assert.match(messages.at(-1), /offline timeout/);
});
test('picker cancellation submits nothing; picker errors reach the caller', async () => {
  const client = new Client('http://laptop', '', async () => { assert.fail('must not upload'); });
  assert.equal(await submitImages(client, native({ pick: async () => null }), signal()), null);
  await assert.rejects(submitImages(client, native({ pick: async () => { throw new Error('Photo permission denied'); } }), signal()), /permission denied/);
});
test('successful upload uses backend form fields and removes converted files', async () => {
  const io = native();
  const client = new Client('http://laptop', 'shared', async (url, options) => {
    assert.equal(url, 'http://laptop/api/v1/jobs'); assert.equal(options.body.getAll('images').length, 1);
    assert.equal(await options.body.get('images').text(), 'native-image-bytes');
    assert.equal(options.body.get('images').name, 'mobile-0.jpg');
    assert.equal(options.body.get('submitted_from'), 'mobile');
    assert.equal(options.body.get('max_width'), '1280'); assert.equal(options.body.get('max_height'), '720');
    return response(job, 202);
  });
  assert.deepEqual(await submitImages(client, io, signal()), job); assert.deepEqual(io.removed, ['source.jpg']);
});
test('upload failure and partial conversion failure remove temporary images', async () => {
  const client = new Client('http://laptop', '', async () => response({ error: 'upload failed' }, 400));
  const io = native(); await assert.rejects(submitImages(client, io, signal()), /upload failed/);
  assert.deepEqual(io.removed, ['source.jpg']);
  const partial = native({ pick: async () => [{ uri: 'one' }, { uri: 'broken' }], jpeg: async uri => { if (uri === 'broken') throw new Error('decode failed'); return uri + '.jpg'; } });
  await assert.rejects(submitImages(client, partial, signal()), /decode failed/); assert.deepEqual(partial.removed, ['one.jpg']);
});
test('image count, source size, and normalized size limits prevent oversized uploads', async () => {
  const client = new Client('http://laptop', '', async () => { assert.fail('must not upload'); });
  await assert.rejects(submitImages(client, native({ pick: async () => Array(101).fill({ uri: 'one' }) }), signal()), /at most 100/);
  await assert.rejects(submitImages(client, native({ pick: async () => [{ uri: 'one', fileSize: MAX_BYTES + 1 }] }), signal()), /100 MB/);
  const io = native({ size: () => MAX_BYTES + 1 });
  await assert.rejects(submitImages(client, io, signal()), /100 MB/); assert.deepEqual(io.removed, ['source.jpg']);
});
test('cancellation after conversion removes its file and never uploads', async () => {
  const controller = new AbortController();
  const io = native({ jpeg: async () => { controller.abort(); return 'converted'; } });
  const client = new Client('http://laptop', '', async () => { assert.fail('must not upload'); });
  await assert.rejects(submitImages(client, io, controller.signal), /cancelled/); assert.deepEqual(io.removed, ['converted']);
});
test('resize preserves aspect ratio for landscape and portrait without upscaling', () => {
  assert.deepEqual(resizedDimensions(120, 80, 60, 60), { width: 60, height: 40 });
  assert.deepEqual(resizedDimensions(80, 120, 60, 60), { width: 40, height: 60 });
  assert.deepEqual(resizedDimensions(20, 10, 60, 60), { width: 20, height: 10 });
  assert.throws(() => resizedDimensions(0, 100, 60, 60));
});
test('worker downloads with token, resizes, uploads and removes both files', async () => {
  let resized;
  const io = native({ jpeg: async (_uri, size) => { resized = size; return 'output.jpg'; } });
  const client = new Client('http://laptop', 'shared', async (url, options) => {
    assert.match(url, /task123\/result$/); assert.equal(options.body.getAll('image').length, 1);
    assert.equal(await options.body.get('image').text(), 'native-image-bytes');
    assert.equal(options.body.get('image').name, 'sample.jpg');
    return response({ status: 'accepted' });
  });
  await processTask(client, io, 'phone', task, signal());
  assert.deepEqual(resized, { width: 60, height: 40 }); assert.equal(io.downloads[0][2]['X-Edge-Token'], 'shared');
  assert.deepEqual(io.removed, ['cache/task123-input', 'output.jpg']);
});
test('worker upload failure still removes input and output files', async () => {
  const io = native(), client = new Client('http://laptop', '', async () => response({ error: 'late result' }, 409));
  await assert.rejects(processTask(client, io, 'phone', task, signal()), /late result/); assert.equal(io.removed.length, 2);
});
test('ZIP sharing uses original coordinator, retains shared file and cleans previous download', async () => {
  const io = native(), downloads = new ResultDownloads(io), client = new Client('http://original-laptop', 'shared');
  await downloads.share(client, 'job-one', signal());
  assert.match(io.downloads[0][0], /^http:\/\/original-laptop\//); assert.deepEqual(io.shared, ['cache/job-one-results.zip']); assert.equal(io.removed.length, 0);
  await downloads.share(client, 'job-two', signal()); assert.deepEqual(io.removed, ['cache/job-one-results.zip']);
  downloads.clear(); assert.equal(io.removed.at(-1), 'cache/job-two-results.zip');
});
test('sharing unavailable, download failure and share failure reach the UI', async () => {
  const client = new Client('http://laptop', '');
  await assert.rejects(new ResultDownloads(native({ sharingAvailable: async () => false })).share(client, 'job', signal()), /unavailable/);
  await assert.rejects(new ResultDownloads(native({ download: async () => { throw new Error('download failed'); } })).share(client, 'job', signal()), /download failed/);
  const io = native({ share: async () => { throw new Error('sharing failed'); } });
  await assert.rejects(new ResultDownloads(io).share(client, 'job', signal()), /sharing failed/); assert.deepEqual(io.removed, ['cache/job-results.zip']);
});
test('HTTP adapter checks protocol, sends device identity and handles idle polling', async () => {
  const requests = [];
  const client = new Client('http://laptop', 'shared', async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/status')) return response({ protocol_version: '1.1' });
    if (url.endsWith('/register')) return response({ worker_id: 'phone', protocol_version: '1.1' }, 201);
    if (url.includes('/tasks/next') || options.method === 'DELETE') return response(null, 204);
    return response({ status: 'online' });
  });
  const io = workerIO(client, native(), async () => ({ client_id: 'abc', total_memory_mb: 1024, free_memory_mb: 512 }));
  assert.equal(await io.register(), 'phone'); assert.equal(await io.next('phone', signal()), null);
  await io.heartbeat('phone', signal()); await io.withdraw('phone');
  assert.equal(JSON.parse(requests[1].options.body).client_id, 'abc'); assert.match(requests[2].url, /free_memory_mb=512/); assert.equal(requests.at(-1).options.method, 'DELETE');
});
test('only completed and failed jobs are terminal', () => {
  assert.equal(terminalJob(job), false); assert.equal(terminalJob({ ...job, status: 'completed' }), true); assert.equal(terminalJob({ ...job, status: 'failed' }), true);
});

test('generated SDK 58 configs permit LAN HTTP and declare iOS privacy descriptions', () => {
  const expoHome = mkdtempSync(join(tmpdir(), 'edge-mesh-config-test-'));
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const output = execFileSync(process.execPath, ['node_modules/expo/bin/cli', 'config', '--type', 'introspect', '--json'], {
      cwd: root, timeout: 30000,
      env: { ...process.env, EXPO_NO_TELEMETRY: '1', __UNSAFE_EXPO_HOME_DIRECTORY: expoHome },
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    const config = JSON.parse(output);
    assert.equal(config.sdkVersion, '58.0.0', 'Project must match SDK 58 Expo Go on physical iPhones');
    const native = config._internal.modResults;
    assert.equal(native.android.manifest.manifest.application[0].$['android:usesCleartextTraffic'], 'true');
    assert.equal(native.ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking, true);
    assert.ok(native.ios.infoPlist.NSLocalNetworkUsageDescription);
    assert.ok(native.ios.infoPlist.NSPhotoLibraryUsageDescription);
  } finally { rmSync(expoHome, { recursive: true, force: true }); }
});
