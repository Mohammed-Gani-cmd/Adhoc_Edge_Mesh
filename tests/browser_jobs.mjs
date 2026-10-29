// Real Chromium checks for the built React dashboard and the HTML fallback.
// Start tests/browser_jobs_server.py first. No browser automation packages required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = 'http://127.0.0.1:5505';
const profile = mkdtempSync(join(tmpdir(), 'edge-mesh-chromium-'));
const chrome = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=9225', '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const imagePath = fileURLToPath(new URL('../demo_images/demo_01.jpg', import.meta.url));
let socket;
let nextId = 0;
const pending = new Map();
async function command(method, params = {}) {
  const id = ++nextId;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return promise;
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + JSON.stringify(result.exceptionDetails.exception));
  return result.result.value;
}
async function until(expression, timeout = 7000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await evaluate(expression); if (last) return last; } catch {}
    await delay(80);
  }
  throw new Error('Timed out: ' + expression + ' (last value ' + JSON.stringify(last) + ')');
}
async function json(path, options) {
  const response = await fetch(base + path, options);
  assert.equal(response.status < 400, true, path + ': ' + response.status);
  return response.json();
}
async function submit(source = 'mobile') {
  const body = new FormData();
  body.append('images', new Blob([readFileSync(imagePath)], { type: 'image/jpeg' }), source + '-external.jpg');
  body.append('submitted_from', source);
  return json('/api/v1/jobs', { method: 'POST', body });
}
async function completed(id) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const job = await json('/api/v1/jobs/' + id);
    if (job.status === 'completed') return job;
    assert.notEqual(job.status, 'failed');
    await delay(50);
  }
  throw new Error('Job did not finish');
}
async function select(id) {
  await evaluate(`(() => { const select=document.querySelector('#job-selector'); select.value=${JSON.stringify(id)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await until(`(document.querySelector('[data-testid="selected-job"]') || document.querySelector('#jobMeta'))?.textContent.includes(${JSON.stringify('#' + id)})`);
}
async function runDashboard(path, label) {
  await json('/__test__/reset', { method: 'POST' });
  await command('Page.navigate', { url: base + path });
  await until(`document.querySelector('#job-selector') && document.querySelector('#job-selector').options.length===1 && document.querySelector('#job-selector').value===''`);

  const first = await submit();
  await completed(first.job_id); // Completed before the next discovery poll.
  const discoveryStart = Date.now();
  await until(`document.querySelector('#job-selector')?.value===${JSON.stringify(first.job_id)}`, 3000);
  assert.ok(Date.now() - discoveryStart < 2500, 'phone submission discovery took too long');
  await until(`document.querySelector('#job-selector').selectedOptions[0].textContent.includes('Phone')`);
  await until(`!!document.querySelector('a[href="/api/v1/jobs/${first.job_id}/download"]')`);

  const s3 = status => json('/__test__/s3', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: first.job_id, status }) });
  await s3('pending');
  await command('Page.reload');
  await until(`document.body.textContent.includes('Saving results ZIP to S3')`);
  await s3('saved');
  await until(`document.body.textContent.includes('Saved to s3://browser-test-bucket/edge-mesh/tasks/results/${first.job_id}/results.zip')`);
  await s3('pending');
  await command('Page.reload');
  await until(`document.body.textContent.includes('Saving results ZIP to S3')`);
  await s3('failed');
  await until(`Array.from(document.querySelectorAll('[role=alert]')).some(node=>node.textContent.includes('Could not save results to S3'))`);

  const second = await submit();
  await completed(second.job_id);
  await until(`Array.from(document.querySelector('#job-selector').options).some(option=>option.value===${JSON.stringify(second.job_id)})`);
  assert.equal(await evaluate(`document.querySelector('#job-selector').value`), first.job_id);
  await until(`document.body.textContent.includes('New jobs available')`);
  await select(second.job_id);

  await command('Page.reload');
  await until(`document.querySelector('#job-selector')?.value===${JSON.stringify(second.job_id)}`);

  // A submission through the actual upload form must select the new browser job.
  const doc = await command('DOM.getDocument');
  const input = await command('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  await command('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [imagePath] });
  await evaluate(`(() => { const button=document.querySelector('#submitBtn') || Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('Distribute job')); button.click(); })()`);
  let own;
  for (let attempt = 0; attempt < 50; attempt++) {
    own = (await json('/api/v1/jobs')).jobs.find(row => row.submitted_from === 'web');
    if (own) break;
    await delay(100);
  }
  assert.ok(own, 'browser form did not submit');
  await until(`document.querySelector('#job-selector').value===${JSON.stringify(own.job_id)}`);
  await until(`document.querySelector('#job-selector').selectedOptions[0].textContent.includes('Browser')`);
  await completed(own.job_id);

  // Ignore abort on purpose and deliver an old selection's response late.
  await evaluate(`window.__originalFetch=window.fetch; window.__slowRequested=false; window.fetch=(url,options)=>{ if(url===${JSON.stringify('/api/v1/jobs/' + first.job_id)}) { window.__slowRequested=true; return window.__originalFetch(url,{...options,signal:undefined}).then(response=>new Promise(resolve=>setTimeout(()=>resolve(response),1400))); } return window.__originalFetch(url,options); };`);
  await evaluate(`(() => { const s=document.querySelector('#job-selector'); s.value=${JSON.stringify(first.job_id)}; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await until('window.__slowRequested');
  await select(second.job_id);
  await delay(1800);
  assert.equal(await evaluate(`(document.querySelector('[data-testid="selected-job"]') || document.querySelector('#jobMeta')).textContent.includes(${JSON.stringify('#' + second.job_id)})`), true);
  await evaluate('window.fetch=window.__originalFetch');

  // Job discovery must recover independently of peer discovery and network errors.
  await evaluate(`window.__originalFetch=window.fetch; window.fetch=(url,options)=>url==='/api/v1/jobs' && (!options?.method || options.method==='GET') ? Promise.reject(new TypeError('Offline test')) : window.__originalFetch(url,options);`);
  await until(`Array.from(document.querySelectorAll('[role=alert]')).some(node=>node.textContent.length>0)`);
  await evaluate('window.fetch=window.__originalFetch');
  await until(`Array.from(document.querySelectorAll('[role=alert]')).every(node=>!node.textContent)`);
  await evaluate(`window.__originalFetch=window.fetch; window.fetch=(url,options)=>url==='/api/v1/peers' ? new Promise(()=>{}) : window.__originalFetch(url,options);`);
  const third = await submit();
  await until(`Array.from(document.querySelector('#job-selector').options).some(option=>option.value===${JSON.stringify(third.job_id)})`);
  assert.equal(await evaluate(`document.querySelector('#job-selector').value`), second.job_id);
  await evaluate('window.fetch=window.__originalFetch');

  await select(first.job_id);
  await json('/__test__/age', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: first.job_id }) });
  await until(`document.querySelector('#job-selector').selectedOptions[0].textContent.includes('Selected older')`);
  await until(`(document.querySelector('[data-testid="selected-job"]') || document.querySelector('#jobMeta')).textContent.includes(${JSON.stringify('#' + first.job_id)})`);
  await json('/__test__/reset', { method: 'POST' });
  await until(`document.body.textContent.includes('Job unavailable')`);
  const afterRestart = await submit();
  await until(`Array.from(document.querySelector('#job-selector').options).some(option=>option.value===${JSON.stringify(afterRestart.job_id)})`);
  await select(afterRestart.job_id);
  await until(`Array.from(document.querySelectorAll('[role=alert]')).every(node=>!node.textContent)`);
  console.log(label + ': phone discovery, completed jobs, stable selection, browser upload, reload, stale responses, network recovery, stalled peers, older jobs, restart recovery: PASS');
}
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const targets=await (await fetch('http://127.0.0.1:9225/json/list')).json(); target=targets.find(target=>target.type==='page'); if(target) break; } catch {}
    await delay(100);
  }
  assert.ok(target, 'Chromium did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const handler=pending.get(message.id); pending.delete(message.id);
    if (message.error) handler?.reject(new Error(JSON.stringify(message.error)));
    else handler?.resolve(message.result);
  };
  await command('Runtime.enable');
  await runDashboard('/', 'React dashboard');
  await runDashboard('/__test__/legacy', 'HTML fallback');
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  await Promise.race([once(chrome,'exit'),delay(3000)]);
  if (chrome.exitCode===null) chrome.kill('SIGKILL');
  rmSync(profile,{recursive:true,force:true});
}
