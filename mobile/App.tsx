import React from 'react';
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ApiError, messageFor, s3ResultText, terminalJob, wait } from './src/client.ts';
import type { Client, Job } from './src/client.ts';
import { WorkerSession } from './src/worker.ts';
import { ResultDownloads, submitImages, workerIO } from './src/transfers.ts';
import { deviceMetadata, nativeClient, nativeIO } from './src/native.ts';
import { confirmationFor, durationText, emptyActivity, jobProgress, outcomeText, stageLabel, updateActivity } from './src/activity.ts';
import type { ActivityRecord, TaskStage, WorkerEvent } from './src/activity.ts';
import { ActionButton, Badge, Card, colors, Metric, Notice, Progress, SectionHeading, styles as s } from './src/ui.tsx';
import type { Tone } from './src/ui.tsx';

type LinkedJob = { key: string; client: Client; id: string; job?: Job; error?: string; unavailable?: boolean; refreshedAt?: number };
type Connection = { state: 'unchecked' | 'checking' | 'connected' | 'error'; name?: string; at?: number; rtt?: number; error?: string };
type DeviceInfo = Extract<WorkerEvent, { kind: 'device' }>;
const jobKey = (base: string, id: string) => `${base}/${id}`;
const activeStages: TaskStage[] = ['downloading', 'resizing', 'uploading', 'confirming'];
const stageTone = (stage: TaskStage): Tone => stage === 'accepted' ? 'success' : ['failed', 'pending', 'cancelled'].includes(stage) ? 'warning' : 'info';
const timeText = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function JobCard({ entry, now, onShare, busy, note }: { entry: LinkedJob; now: number; onShare: () => void; busy: boolean; note?: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const job = entry.job;
  const stats = job && jobProgress(job);
  return <Card>
    <View style={s.row}><View style={{ flex: 1 }}><Text style={s.eyebrow}>RELATED JOB</Text><Text style={s.title}>#{entry.id}</Text></View><Badge label={job?.status || (entry.unavailable ? 'unavailable' : 'loading')} tone={job?.status === 'completed' ? 'success' : job?.status === 'failed' ? 'danger' : 'info'} /></View>
    <Text style={s.small}>{entry.client.base}</Text>
    {job && stats && <>
      <View style={s.row}><Text style={s.text}>{stats.completed} of {stats.total} images completed</Text><Text style={[s.text, { color: colors.teal, fontWeight: '700' }]}>{stats.percent}%</Text></View>
      <Progress percent={stats.percent} />
      <View style={s.wrap}><Badge label={`${stats.processing} processing`} tone="info" /><Badge label={`${stats.failed} failed`} tone={stats.failed ? 'danger' : 'neutral'} /><Badge label={`${job.max_width} × ${job.max_height}`} /></View>
      <Text style={s.small}>{durationText(job.duration != null ? job.duration * 1000 : now - job.created_at * 1000)} elapsed{job.node_contributions && Object.keys(job.node_contributions).length ? ` · ${Object.entries(job.node_contributions).map(([node, count]) => `${node}: ${count}`).join(' · ')}` : ''}</Text>
      <Notice text={job.error || undefined} danger />
      <Notice text={s3ResultText(job)} danger={job.s3_result?.status === 'failed'} />
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}><Text style={s.link}>{expanded ? 'Hide image and attempt details −' : 'View image and attempt details +'}</Text></Pressable>
      {expanded && job.items.map(item => <View key={item.id} style={s.taskBox}>
        <Text style={s.filename}>{item.source_name}</Text>
        <View style={s.wrap}><Badge label={item.state} tone={item.state === 'completed' ? 'success' : item.state === 'failed' ? 'danger' : 'info'} />{item.execution_location && <Badge label={item.execution_location} />}</View>
        <Text style={s.small}>{item.assigned_node || 'Waiting for assignment'}{item.output_size ? ` · ${item.output_size.join(' × ')}` : ''}{item.processing_ms != null ? ` · ${Math.round(item.processing_ms)} ms` : ''}</Text>
        {item.attempts.map((attempt, index) => <Text key={index} style={[s.small, attempt.status === 'failed' && { color: colors.amber }]}>{index + 1}. {attempt.node} · {attempt.status}{attempt.error ? `\n${attempt.error}` : ''}</Text>)}
      </View>)}
      {terminalJob(job) && stats.completed > 0 && <ActionButton title="Save or share ZIP" onPress={onShare} disabled={busy} secondary />}
    </>}
    <Notice text={entry.error} danger />
    <Notice text={note} />
  </Card>;
}

function ActivityRow({ record, job }: { record: ActivityRecord; job?: Job }) {
  const [expanded, setExpanded] = React.useState(false);
  return <View style={s.activity}>
    <View style={s.row}><Text style={[s.filename, { flex: 1 }]} numberOfLines={2}>{record.task.filename}</Text><Text style={s.small}>{timeText(record.at)}</Text></View>
    <View style={s.wrap}><Badge label={stageLabel(record.stage)} tone={stageTone(record.stage)} />{record.task.job_id && <Badge label={`#${record.task.job_id}`} />}</View>
    <Text style={[s.small, job?.status === 'completed' && { color: colors.teal }]}>{outcomeText(record, job)}</Text>
    {record.error && <><Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}><Text style={s.link}>{expanded ? 'Hide attempt diagnostic −' : 'View attempt diagnostic +'}</Text></Pressable>{expanded && <Notice text={`${record.failedStage ? stageLabel(record.failedStage) + '\n' : ''}${record.error}`} />}</>}
  </View>;
}

function Dashboard() {
  const [coordinator, setCoordinator] = React.useState('');
  const [token, setToken] = React.useState('demo123');
  const [settingsOpen, setSettingsOpen] = React.useState(true);
  const [phase, setPhase] = React.useState<'offline' | 'joining' | 'online' | 'stopping'>('offline');
  const [workerId, setWorkerId] = React.useState('');
  const [workerNote, setWorkerNote] = React.useState('Ready to contribute. Join when your laptop is connected.');
  const [connection, setConnection] = React.useState<Connection>({ state: 'unchecked' });
  const [device, setDevice] = React.useState<DeviceInfo | null>(null);
  const [activity, setActivity] = React.useState(emptyActivity);
  const [jobs, setJobs] = React.useState<LinkedJob[]>([]);
  const [foreground, setForeground] = React.useState(AppState.currentState === 'active');
  const [refresh, setRefresh] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [busyKind, setBusyKind] = React.useState<'connection' | 'submission' | 'sharing' | null>(null);
  const [actionNote, setActionNote] = React.useState('');
  const [shareNotes, setShareNotes] = React.useState<Record<string, string>>({});
  const [startedAt, setStartedAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(Date.now());
  const session = React.useRef<WorkerSession | null>(null);
  const sessionBase = React.useRef('');
  const jobsRef = React.useRef(jobs);
  const activityRef = React.useRef(activity);
  const action = React.useRef<AbortController | null>(null);
  const mounted = React.useRef(true);
  const downloads = React.useRef(new ResultDownloads(nativeIO));
  const locked = phase !== 'offline' || busy;

  const notifyWorker = React.useCallback((text: string) => { if (mounted.current) setWorkerNote(text); }, []);
  const linkJob = React.useCallback((client: Client, id: string, job?: Job) => {
    setJobs(previous => {
      const key = jobKey(client.base, id);
      const existing = previous.find(entry => entry.key === key);
      const next = [{ ...existing, key, id, client, ...(job ? { job, refreshedAt: Date.now(), error: undefined, unavailable: false } : {}) }, ...previous.filter(entry => entry.key !== key)].slice(0, 10);
      jobsRef.current = next;
      return next;
    });
  }, []);

  const startWorker = async () => {
    if (session.current || action.current || AppState.currentState !== 'active') return;
    try {
      const client = nativeClient(coordinator, token);
      sessionBase.current = client.base;
      const observe = (event: WorkerEvent) => {
        if (!mounted.current || session.current !== worker) return;
        if (event.kind === 'device') setDevice(event);
        if (event.kind === 'contact') setConnection(previous => ({ ...previous, state: 'connected', at: event.at, rtt: event.rttMs ?? previous.rtt, error: undefined }));
        if (event.kind === 'task') {
          setActivity(previous => { const next = updateActivity(previous, event, client.base); activityRef.current = next; return next; });
          if (event.task.job_id) linkJob(client, event.task.job_id);
        }
      };
      const worker = new WorkerSession(workerIO(client, nativeIO, deviceMetadata, observe), text => { if (session.current === worker) notifyWorker(text); },
        (id, stopping) => {
          if (!mounted.current || session.current !== worker) return;
          setWorkerId(id);
          setPhase(id ? 'online' : stopping ? 'stopping' : 'offline');
          if (id) { setStartedAt(Date.now()); setSettingsOpen(false); }
          if (!id && !stopping) session.current = null;
        }, 800, 5000, observe);
      session.current = worker;
      setPhase('joining');
      notifyWorker('Checking the coordinator and registering this phone…');
      try { await worker.start(); }
      catch (error) { await worker.stop(messageFor(error)); }
    } catch (error) { notifyWorker(messageFor(error)); }
  };

  const runAction = async (operation: (signal: AbortSignal) => Promise<void>, onError: (text: string) => void = setActionNote, kind: 'connection' | 'submission' | 'sharing' = 'submission') => {
    if (action.current) return;
    const controller = new AbortController(); action.current = controller; setBusy(true); setBusyKind(kind);
    try { await operation(controller.signal); }
    catch (error) { if (!controller.signal.aborted && mounted.current) onError(messageFor(error)); }
    finally { if (action.current === controller) action.current = null; if (mounted.current) { setBusy(false); setBusyKind(null); } }
  };
  const checkConnection = () => runAction(async signal => {
    setConnection({ state: 'checking' });
    const client = nativeClient(coordinator, token), start = Date.now();
    const status = await client.check(signal);
    setConnection({ state: 'connected', name: status.display_name, at: Date.now(), rtt: Date.now() - start });
    setSettingsOpen(false);
  }, error => setConnection({ state: 'error', error }), 'connection');
  const submit = () => runAction(async signal => {
    const client = nativeClient(coordinator, token);
    await client.check(signal); setActionNote('Choose up to 100 images. Total upload limit: 100 MB.');
    const job = await submitImages(client, nativeIO, signal);
    if (signal.aborted || !mounted.current) return;
    if (job) { linkJob(client, job.job_id, job); setActionNote(`Job #${job.job_id} submitted. Follow its progress below.`); }
    else setActionNote('Image selection cancelled.');
  });
  const share = (entry: LinkedJob) => runAction(async signal => {
    setShareNotes(previous => ({ ...previous, [entry.key]: 'Downloading ZIP…' }));
    await downloads.current.share(entry.client, entry.id, signal);
    if (mounted.current) setShareNotes(previous => ({ ...previous, [entry.key]: 'Share sheet closed. Choose Save to Files or another destination to keep the ZIP.' }));
  }, error => setShareNotes(previous => ({ ...previous, [entry.key]: error })), 'sharing');

  React.useEffect(() => {
    if (!foreground) return;
    const controller = new AbortController();
    let first = true;
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const force = first && refresh > 0; first = false;
          const pending = jobsRef.current.filter(entry => !entry.unavailable && (force || !entry.job || !terminalJob(entry.job) || ['pending', 'uploading'].includes(entry.job.s3_result?.status || '') || activityRef.current.records.some(record => record.base === entry.client.base && record.task.job_id === entry.id && ['pending', 'confirming', 'cancelled'].includes(record.stage))));
          await Promise.all(pending.map(async entry => {
            try {
              const job = await entry.client.json<Job>(`/api/v1/jobs/${entry.id}`, {}, controller.signal, 5000);
              if (controller.signal.aborted) return;
              setJobs(previous => { const next = previous.map(row => row.key === entry.key ? { ...row, job, error: undefined, refreshedAt: Date.now() } : row); jobsRef.current = next; return next; });
              setActivity(previous => {
                let next = previous;
                for (const record of previous.records) {
                  if (record.base !== entry.client.base || record.task.job_id !== entry.id || !['pending', 'confirming', 'cancelled'].includes(record.stage)) continue;
                  const stage = confirmationFor(job, record.task, record.workerId);
                  if (stage !== 'pending') next = updateActivity(next, { ...record, stage, at: Date.now() }, record.base);
                }
                activityRef.current = next;
                return next;
              });
            } catch (error) {
              if (controller.signal.aborted) return;
              setJobs(previous => { const next = previous.map(row => row.key === entry.key ? { ...row, error: messageFor(error), unavailable: error instanceof ApiError && error.status === 404 } : row); jobsRef.current = next; return next; });
            }
          }));
          await wait(1500, controller.signal);
        }
      } catch { /* Cancellation ends foreground polling. */ }
    })();
    return () => controller.abort();
  }, [foreground, refresh]);

  React.useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const listener = AppState.addEventListener('change', state => {
      setForeground(state === 'active');
      if (state !== 'active') void session.current?.stop('Worker paused when the app left the foreground. Join again to resume.');
    });
    return () => { mounted.current = false; clearInterval(timer); listener.remove(); action.current?.abort(); void session.current?.stop(); downloads.current.clear(); };
  }, []);

  const current = activity.records.find(record => record.base === sessionBase.current && record.workerId === workerId && activeStages.includes(record.stage));
  const stageIndex = current ? ['downloading', 'resizing', 'uploading', 'confirming'].indexOf(current.stage) : -1;
  const lastContact = connection.at ? `${durationText(now - connection.at)} ago` : 'Not connected';
  const editConnection = (value: string, field: 'url' | 'token') => { field === 'url' ? setCoordinator(value) : setToken(value); setConnection({ state: 'unchecked' }); };

  return <SafeAreaView style={s.root}><StatusBar style="light" /><KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <View style={s.header}><View style={s.brandRow}><View style={s.brandMark}><Text style={s.brandLetters}>EM</Text></View><View><Text style={s.brand}>Edge Mesh</Text><Text style={s.small}>MOBILE COMPUTE</Text></View></View><Badge label={connection.state === 'connected' ? 'Connected' : connection.state === 'error' ? 'Connection issue' : 'Local network'} tone={connection.state === 'connected' ? 'success' : connection.state === 'error' ? 'warning' : 'neutral'} /></View>
    <View><Text style={s.headline}>A little device.{'\n'}Part of something bigger.</Text><Text style={s.subtitle}>Contribute your phone’s compute and follow every handoff across your mesh.</Text></View>
    <Card>
      <View style={s.row}><View style={{ flex: 1 }}><Text style={s.eyebrow}>01 / CONNECTION</Text><Text style={s.title}>{connection.name || 'Laptop coordinator'}</Text></View><ActionButton title={settingsOpen ? 'Collapse' : 'Settings'} compact secondary onPress={() => setSettingsOpen(value => !value)} /></View>
      {!settingsOpen && <><Text style={s.text}>{coordinator || 'Enter the laptop LAN address'}</Text><Text style={s.small}>Last contact: {lastContact}{connection.rtt != null ? ` · ${connection.rtt} ms RTT` : ''}</Text></>}
      {settingsOpen && <>
        <View><Text style={s.label}>Coordinator URL</Text><TextInput accessibilityLabel="Laptop coordinator URL" autoCapitalize="none" autoCorrect={false} keyboardType="url" style={s.input} placeholder="http://192.168.1.10:5000" placeholderTextColor={colors.muted} value={coordinator} onChangeText={value => editConnection(value, 'url')} editable={!locked} /></View>
        <View><Text style={s.label}>Shared worker token</Text><TextInput accessibilityLabel="Shared worker token" autoCapitalize="none" autoCorrect={false} secureTextEntry style={s.input} value={token} onChangeText={value => editConnection(value, 'token')} editable={!locked} /></View>
        <ActionButton title="Check connection" loading={connection.state === 'checking'} onPress={() => void checkConnection()} disabled={locked} secondary />
        <Text style={s.small}>{phase !== 'offline' ? 'Pause the worker to edit connection settings.' : 'Use the laptop’s Wi-Fi IP. Joining also checks your worker token.'}</Text>
      </>}
      <Notice text={connection.error} danger />
    </Card>
    <Card style={s.hero}>
      <View style={s.row}><Text style={s.eyebrow}>02 / YOUR WORKER</Text><Badge label={phase === 'online' ? current ? 'Processing' : 'Ready for work' : phase === 'joining' ? 'Connecting' : phase === 'stopping' ? 'Disconnecting' : 'Paused'} tone={phase === 'online' ? 'success' : 'neutral'} /></View>
      <View><Text style={[s.title, { fontSize: 25 }]}>{device?.name || 'This phone'}</Text><Text style={s.small}>{device ? `${device.platform.toUpperCase()} · 1 task at a time` : 'Join the mesh to contribute compute'}</Text></View>
      <View style={s.metricRow}><Metric label="Accepted results" value={activity.accepted} accent /><Metric label="Failed attempts" value={activity.failed} /><Metric label="Online time" value={phase === 'online' && startedAt ? durationText(now - startedAt) : '—'} /></View>
      {current ? <View style={s.taskBox}>
        <Text style={s.label}>CURRENT IMAGE</Text><Text style={s.filename} numberOfLines={2}>{current.task.filename}</Text><Text style={[s.text, { color: colors.teal }]}>{stageLabel(current.stage)}</Text>
        <View style={s.stages}>{[0, 1, 2, 3].map(index => <View key={index} style={[s.segment, index <= stageIndex && { backgroundColor: colors.teal }]} />)}</View>
        <Text style={s.small}>{current.task.max_width} × {current.task.max_height} max · {durationText(now - current.startedAt)}</Text>
      </View> : <View style={s.taskBox}><Text style={s.text}>{phase === 'online' ? 'Listening for the next image' : 'Ready when you are'}</Text><Text style={s.small}>{phase === 'online' ? 'The coordinator assigns work when this phone has capacity.' : 'Keep this screen open while contributing compute.'}</Text></View>}
      <ActionButton title={phase === 'offline' ? 'Join mesh as worker' : phase === 'joining' ? 'Cancel joining' : phase === 'stopping' ? 'Disconnecting…' : 'Pause worker'} loading={phase === 'joining' || phase === 'stopping'} onPress={() => { if (session.current) void session.current.stop(); else void startWorker(); }} disabled={phase === 'stopping' || (busy && phase === 'offline')} secondary={phase !== 'offline'} />
      <Notice text={workerNote} />
      {device && <Text style={s.small}>Memory: {(device.memoryMb / 1024).toFixed(1)} GB total · {(device.estimatedFreeMb / 1024).toFixed(1)} GB free (estimated){connection.rtt != null ? `\nPolling latency: ${connection.rtt} ms · Last contact ${lastContact}` : ''}</Text>}
      {workerId && <Text selectable style={s.small}>Worker ID · {workerId}</Text>}
    </Card>
    <SectionHeading eyebrow="03 / WORKLOAD" title="Your related jobs" aside={`${jobs.length} this session`} />
    <Card><Text style={s.title}>Send a batch from your phone</Text><Text style={s.small}>Up to 100 images · 100 MB total · 1280 × 720 max</Text><ActionButton title="Choose images and submit" loading={busyKind === 'submission'} onPress={() => void submit()} disabled={busy || ['joining', 'stopping'].includes(phase)} /><Notice text={actionNote} /></Card>
    {jobs.length > 0 && <ActionButton title="Refresh related jobs" compact secondary onPress={() => { setJobs(previous => { const next = previous.map(entry => ({ ...entry, unavailable: false })); jobsRef.current = next; return next; }); setRefresh(value => value + 1); }} disabled={busy} />}
    {jobs.map(entry => <JobCard key={entry.key} entry={entry} now={now} onShare={() => void share(entry)} busy={busy} note={shareNotes[entry.key]} />)}
    {!jobs.length && <Card><View style={s.empty}><Text style={s.emptyTitle}>Your next job starts here</Text><Text style={s.emptyText}>Submit a batch, or leave the worker online. Jobs assigned from the laptop will appear here too.</Text></View></Card>}
    <SectionHeading eyebrow="04 / PHONE ACTIVITY" title="Every attempt, explained" aside={`${activity.records.length} recent`} />
    <Card><Text style={s.small}>A phone attempt can fail while the overall job succeeds on another worker. Both outcomes appear below.</Text>
      {activity.records.map(record => <ActivityRow key={`${record.base}/${record.task.task_id}`} record={record} job={jobs.find(entry => entry.key === jobKey(record.base, record.task.job_id || ''))?.job} />)}
      {!activity.records.length && <View style={s.empty}><Text style={s.emptyTitle}>No phone attempts yet</Text><Text style={s.emptyText}>Downloading, resizing, uploading, and coordinator confirmation will show here.</Text></View>}
    </Card>
    <Text style={[s.small, { textAlign: 'center' }]}>Trusted LAN · Foreground worker · Session-only history</Text>
  </ScrollView></KeyboardAvoidingView></SafeAreaView>;
}

export default function App() { return <SafeAreaProvider><Dashboard /></SafeAreaProvider>; }
