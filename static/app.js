let jobId = null;
let currentJob = null;
let recentJobs = [];
let seenJobs = null;
let hasNewJobs = false;
let listBusy = false;
let detailController = null;
let detailTimer = null;
let detailGeneration = 0;
let detailSignature = '';
const $ = id => document.getElementById(id);
const terminal = status => status === 'completed' || status === 'failed';
const sourceLabel = source => source === 'mobile' ? 'Phone' : source === 'web' ? 'Browser' : 'Unknown source';
const localModeControl = ['127.0.0.1', 'localhost'].includes(location.hostname) && ['5000', '5173'].includes(location.port);
let executionMode = 'mesh';
let modeBusy = false;
let cloudEnabled = false;

function renderMode() {
  $('modeButton').textContent = executionMode === 'cloud' ? 'Turn Cloud Off' : 'Turn Cloud On';
  $('modeButton').disabled = !localModeControl || modeBusy || (executionMode === 'mesh' && !cloudEnabled);
  $('modeButton').title = !localModeControl ? 'Open this dashboard on the coordinator at 127.0.0.1:5000 to change Cloud mode' : executionMode === 'mesh' && !cloudEnabled ? 'AWS is unavailable on this coordinator' : '';
  $('modeState').textContent = executionMode === 'cloud' ? 'Cloud On' : 'Cloud Off';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

async function json(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadPeers() {
  try {
    const [peers, status] = await Promise.all([json('/api/v1/peers'), json('/api/v1/status')]);
    if (!modeBusy) executionMode = status.execution_mode || 'mesh';
    cloudEnabled = status.cloud_fallback_enabled;
    renderMode();
    $('peerCount').textContent = `${peers.filter(p => p.online).length} online`;
    $('peers').innerHTML = peers.map(p => {
      const cpu = Math.round(p.cpu_percent || 0);
      const state = p.online ? 'Online' : 'Offline';
      return `<div class="peer ${p.online ? '' : 'offline'}"><div class="peer-main"><span class="status-dot ${p.online ? 'on' : 'off'}"></span><div><strong>${esc(p.name || p.display_name)}</strong><small>${esc(p.source || 'local')} · ${state}</small></div></div><div class="peer-metrics"><span>${cpu}% CPU</span><span>${Math.round(p.free_memory_mb || 0)} MB free</span><span>${Math.round(p.rtt_ms || 0)} ms</span></div></div>`;
    }).join('');
  } catch (_) {}
}

function renderSelector() {
  let options = !jobId ? '<option value="">No jobs in this coordinator session</option>' : '';
  if (jobId && !recentJobs.some(row => row.job_id === jobId)) options += `<option value="${esc(jobId)}">#${esc(jobId)} · Selected older or unavailable job</option>`;
  options += recentJobs.map(row => `<option value="${esc(row.job_id)}">#${esc(row.job_id)} · ${sourceLabel(row.submitted_from)} · ${esc(row.execution_mode || 'mesh').toUpperCase()} · ${esc(row.status)} · ${row.completed_count}/${row.item_count} completed · ${esc(new Date(row.created_at * 1000).toLocaleString())}</option>`).join('');
  $('job-selector').innerHTML = options;
  $('job-selector').value = jobId || '';
  $('jobDiscoveryNote').textContent = hasNewJobs ? 'New jobs available. Choose one from the list; your current selection is preserved.' : 'Phone and browser submissions appear automatically. Latest 50 jobs; history resets when the coordinator restarts.';
}

function clearJob(unavailable = false) {
  $('jobStatus').textContent = unavailable ? 'UNAVAILABLE' : jobId ? 'LOADING' : 'IDLE';
  $('jobStatus').className = unavailable ? 'pill failed' : 'pill idle';
  $('jobMeta').textContent = jobId ? `Selected #${jobId}` : 'No job submitted yet';
  $('s3Result').textContent = '';
  $('percent').textContent = '0%';
  $('bar').style.width = '0%';
  $('tasks').innerHTML = '';
  $('stats').innerHTML = ['Completed','Processing','Retries','Failed'].map(label => `<div><b>0</b><span>${label}</span></div>`).join('');
  $('download').classList.add('disabled');
  $('download').removeAttribute('href');
}

function attemptDetails(item) {
  if (!item.attempts.length) return '';
  return `<details class="attempt-details"><summary>Attempt details (${item.attempts.length})</summary><ol>${item.attempts.map(attempt => `<li>${esc(attempt.node)} · ${esc(attempt.status)}${attempt.duration_ms != null ? ` · ${esc(attempt.duration_ms)} ms` : ''}${attempt.error ? `<p class="task-error">${esc(attempt.error)}</p>` : ''}</li>`).join('')}</ol></details>`;
}

function renderJob(j) {
  const done = j.items.filter(x => x.state === 'completed').length;
  const processing = j.items.filter(x => x.state === 'processing' || x.state === 'retrying').length;
  const failed = j.items.filter(x => x.state === 'failed').length;
  const retries = j.items.reduce((sum, item) => sum + Math.max(0, item.attempts.length - 1), 0);
  const percent = j.items.length ? Math.round(done / j.items.length * 100) : 0;
  $('jobStatus').textContent = j.status.toUpperCase();
  $('jobStatus').className = `pill ${j.status}`;
  $('jobMeta').textContent = `Viewing #${j.job_id} · ${sourceLabel(j.submitted_from)} · ${esc(j.execution_mode || 'mesh').toUpperCase()} mode · ${new Date(j.created_at * 1000).toLocaleString()} · ${j.items.length} images · ${j.max_width} × ${j.max_height}${j.duration != null ? ` · ${j.duration}s` : ''}`;
  const saved = j.s3_result;
  $('s3Result').textContent = !saved ? '' : saved.status === 'saved' ? `Saved to s3://${saved.bucket}/${saved.key}` : saved.status === 'failed' || saved.status === 'skipped' ? saved.error : 'Saving results ZIP to S3…';
  $('s3Result').setAttribute('role', saved?.status === 'failed' ? 'alert' : 'status');
  $('s3Result').classList.toggle('error', saved?.status === 'failed');
  $('bar').style.width = `${percent}%`;
  $('percent').textContent = `${percent}%`;
  $('stats').innerHTML = `<div><b>${done}</b><span>Completed</span></div><div><b>${processing}</b><span>Processing</span></div><div><b>${retries}</b><span>Retries</span></div><div><b>${failed}</b><span>Failed</span></div>`;
  $('tasks').innerHTML = j.items.map(item => `<tr><td><strong>${esc(item.source_name)}</strong><small>${item.bytes.toLocaleString()} bytes</small>${item.error ? `<p role="alert" class="task-error">${esc(item.error)}</p>` : ''}${attemptDetails(item)}</td><td><span class="state ${esc(item.state)}">${esc(item.state)}</span></td><td>${esc(item.assigned_node || 'Waiting')}${item.execution_location ? `<small>${esc(item.execution_location)}</small>` : ''}</td><td>${item.attempts.length}</td><td>${item.output_size ? esc(item.output_size.join(' × ')) : '—'}</td></tr>`).join('');
  $('download').classList.toggle('disabled', !terminal(j.status) || done === 0);
  if (terminal(j.status) && done > 0) $('download').href = `/api/v1/jobs/${j.job_id}/download`;
  else $('download').removeAttribute('href');
}

function loadJob() {
  detailController?.abort();
  clearTimeout(detailTimer);
  if (!jobId) return;
  const controller = detailController = new AbortController();
  const generation = ++detailGeneration;
  const selected = jobId;
  const poll = async () => {
    try {
      const job = await json(`/api/v1/jobs/${selected}`, { signal: controller.signal });
      if (controller.signal.aborted || generation !== detailGeneration || jobId !== selected) return;
      currentJob = job;
      renderJob(job);
      $('jobDetailError').textContent = '';
      if (!terminal(job.status) || ['pending', 'uploading'].includes(job.s3_result?.status)) detailTimer = setTimeout(poll, 1000);
    } catch (error) {
      if (controller.signal.aborted || generation !== detailGeneration || jobId !== selected) return;
      $('jobDetailError').textContent = error.status === 404 ? 'Job unavailable. The coordinator may have restarted; choose another job.' : 'Could not load job details. Retrying…';
      if (error.status === 404) { currentJob = null; clearJob(true); }
      else detailTimer = setTimeout(poll, 1000);
    }
  };
  void poll();
}

function selectJob(id, seed = null) {
  jobId = id;
  currentJob = seed;
  hasNewJobs = false;
  detailSignature = '';
  $('jobDetailError').textContent = '';
  clearJob();
  renderSelector();
  if (seed) renderJob(seed);
  loadJob();
}

async function loadJobs() {
  if (listBusy) return;
  listBusy = true;
  try {
    const result = await json('/api/v1/jobs');
    recentJobs = result.jobs;
    if (seenJobs && recentJobs.some(row => !seenJobs.has(row.job_id) && row.job_id !== jobId)) hasNewJobs = true;
    seenJobs = new Set(recentJobs.map(row => row.job_id));
    $('jobListError').textContent = '';
    if (!jobId && recentJobs.length) selectJob(recentJobs[0].job_id);
    renderSelector();
    const summary = recentJobs.find(row => row.job_id === jobId);
    const signature = `${jobId}:${summary?.status}:${summary?.completed_count}:${summary?.failed_count}:${!!summary}:${summary ? '' : recentJobs[0]?.job_id}`;
    if (jobId && signature !== detailSignature) { detailSignature = signature; loadJob(); }
  } catch (error) {
    $('jobListError').textContent = error.status === 404 ? 'Job discovery unavailable. Restart the updated coordinator.' : 'Could not refresh jobs. Retrying…';
  } finally { listBusy = false; }
}

$('job-selector').addEventListener('change', event => selectJob(event.target.value));
$('modeButton').addEventListener('click', async () => {
  if (modeBusy) return;
  const next = executionMode === 'mesh' ? 'cloud' : 'mesh';
  if (next === 'cloud' && !window.confirm('Turn on Cloud mode? Every image in each new job will use AWS.')) return;
  modeBusy = true;
  $('modeButton').disabled = true;
  $('modeError').textContent = '';
  try {
    const result = await json('/api/v1/execution-mode', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({execution_mode:next})});
    executionMode = result.execution_mode;
  } catch (error) { $('modeError').textContent = error.message; }
  finally { modeBusy = false; renderMode(); await loadPeers(); }
});
$('refreshJobs').addEventListener('click', () => { void loadJobs(); loadJob(); });
$('jobForm').addEventListener('submit', async event => {
  event.preventDefault();
  const files = $('images').files;
  if (!files.length) return;
  $('uploadMsg').textContent = `Uploading ${files.length} image${files.length === 1 ? '' : 's'}…`;
  $('submitBtn').disabled = true;
  try {
    const body = new FormData(event.target);
    body.append('submitted_from', 'web');
    const job = await json('/api/v1/jobs', { method: 'POST', body });
    selectJob(job.job_id, job);
    $('uploadMsg').textContent = `Job ${job.job_id} submitted in ${job.execution_mode} mode.`;
    void loadJobs();
  } catch (error) { $('uploadMsg').textContent = error.message; }
  finally { $('submitBtn').disabled = false; }
});
$('images').addEventListener('change', () => {
  const count = $('images').files.length;
  $('fileLabel').textContent = count ? `${count} image${count === 1 ? '' : 's'} selected` : 'Choose JPEG, PNG, or WebP images';
});
setInterval(loadPeers, 1000);
async function pollJobs() { await loadJobs(); setTimeout(pollJobs, 1000); }
renderMode();
void loadPeers();
void pollJobs();
