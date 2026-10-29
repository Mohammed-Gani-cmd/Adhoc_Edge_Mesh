// Run browser_mode_server.py first. Exercises both dashboards in Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profile = mkdtempSync(join(tmpdir(), 'edge-mesh-mode-'));
const chrome = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=9226', '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, nextId = 0;
const pending = new Map();
async function command(method, params = {}) {
  const id = ++nextId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await delay(50);
  }
  throw new Error('Timed out: ' + expression);
}
async function verify(path, origin = 'http://127.0.0.1:5000') {
  await command('Page.navigate', { url: origin + path });
  const button = path === '/' ? `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Turn Cloud'))` : `document.querySelector('#modeButton')`;
  const state = path === '/' ? `document.querySelector('[role=status]')` : `document.querySelector('#modeState')`;
  await until(`${button}?.textContent==='Turn Cloud On' && !${button}.disabled`);
  assert.equal(await evaluate(`!!${button}.closest('header')`), true);
  assert.equal(await evaluate(`${state}.textContent`), 'Cloud Off');
  assert.equal(await evaluate(`!!document.querySelector('#executionMode, #execution-mode')`), false);

  await evaluate(`window.__confirmCalls=0; window.confirm=()=>{window.__confirmCalls++;return false}; ${button}.click()`);
  assert.equal(await evaluate('window.__confirmCalls'), 1);
  assert.equal(await evaluate(`${button}.textContent`), 'Turn Cloud On');
  assert.equal((await (await fetch('http://127.0.0.1:5000/api/v1/status')).json()).execution_mode, 'mesh');

  await evaluate(`window.confirm=()=>{window.__confirmCalls++;return true}; window.__originalFetch=window.fetch; window.__releaseMode=null; window.fetch=(url,options)=>url==='/api/v1/execution-mode' ? new Promise(resolve=>{window.__releaseMode=()=>resolve(window.__originalFetch(url,options))}) : window.__originalFetch(url,options); ${button}.click()`);
  await until('!!window.__releaseMode');
  assert.equal(await evaluate(`${button}.disabled`), true);
  assert.equal(await evaluate(`${state}.textContent`), 'Cloud Off');
  await evaluate('window.__releaseMode(); window.fetch=window.__originalFetch');
  await until(`${button}.textContent==='Turn Cloud Off' && !${button}.disabled`);
  assert.equal(await evaluate(`${state}.textContent`), 'Cloud On');

  await evaluate(`${button}.click()`);
  await until(`${button}.textContent==='Turn Cloud On' && !${button}.disabled`);
  assert.equal(await evaluate('window.__confirmCalls'), 2);
  assert.equal(await evaluate(`${state}.textContent`), 'Cloud Off');
  assert.equal((await (await fetch('http://127.0.0.1:5000/api/v1/status')).json()).execution_mode, 'mesh');

  await evaluate(`window.fetch=(url,options)=>url==='/api/v1/execution-mode' ? Promise.resolve(new Response(JSON.stringify({error:'Save failed'}),{status:500,headers:{'Content-Type':'application/json'}})) : window.__originalFetch(url,options); ${button}.click()`);
  await until(`Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent==='Save failed')`);
  assert.equal(await evaluate(`${button}.textContent`), 'Turn Cloud On');
  assert.equal(await evaluate(`${state}.textContent`), 'Cloud Off');
  await evaluate('window.fetch=window.__originalFetch');
  console.log(origin + path + ': PASS');
}

try {
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await (await fetch('http://127.0.0.1:9226/json/list')).json()).find(t => t.type === 'page'); if (target) break; } catch {}
    await delay(100);
  }
  assert.ok(target, 'Chromium did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const handler = pending.get(message.id); pending.delete(message.id);
    if (message.error) handler?.reject(new Error(JSON.stringify(message.error)));
    else handler?.resolve(message.result);
  };
  await command('Runtime.enable');
  await verify('/');
  await verify('/legacy');
  await verify('/', 'http://localhost:5000');
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  await Promise.race([once(chrome, 'exit'), delay(3000)]);
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
