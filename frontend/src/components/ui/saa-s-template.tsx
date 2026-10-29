import React from "react";
import { Activity, ArrowUpRight, CheckCircle2, Cpu, Download, FileImage, HardDrive, Loader2, Menu, Network, RefreshCw, Server, ShieldCheck, Upload, Wifi, X, XCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sourceLabel, useJobs } from "@/hooks/use-jobs";
import type { Job } from "@/hooks/use-jobs";

type Peer = { node_id:string; name?:string; display_name?:string; online:boolean; source?:string; cpu_percent?:number; free_memory_mb?:number; rtt_ms?:number; capacity?:number; in_flight?:number; success_rate?:number };
type Attempt = { node:string; status:string; duration_ms?:number; error?:string };
type Item = { id:string; source_name:string; bytes:number; state:string; attempts:Attempt[]; assigned_node?:string|null; execution_location?:string|null; output_size?:number[]|null; processing_ms?:number|null; error?:string|null };

const api = async <T,>(url:string, options?:RequestInit):Promise<T> => { const r=await fetch(url, options); const d=await r.json(); if(!r.ok) throw new Error(d.error || "Request failed"); return d; };
const fmtBytes = (n:number) => n > 1024*1024 ? `${(n/1024/1024).toFixed(1)} MB` : `${Math.round(n/1024)} KB`;
const stateIcon = (state:string) => state === "completed" ? <CheckCircle2 className="h-4 w-4"/> : state === "processing" ? <Loader2 className="h-4 w-4 animate-spin"/> : state === "failed" ? <XCircle className="h-4 w-4"/> : state === "retrying" ? <RefreshCw className="h-4 w-4"/> : <Activity className="h-4 w-4"/>;

export default function Component() {
  const [mobileMenuOpen,setMobileMenuOpen] = React.useState(false);
  const [peers,setPeers] = React.useState<Peer[]>([]);
  const [cloudEnabled,setCloudEnabled] = React.useState(false);
  const [executionMode,setExecutionMode] = React.useState<'mesh'|'cloud'>('mesh');
  const [modeBusy,setModeBusy] = React.useState(false);
  const modeBusyRef = React.useRef(false);
  const [modeError,setModeError] = React.useState('');
  const localModeControl = ['127.0.0.1','localhost'].includes(window.location.hostname) && ['5000','5173'].includes(window.location.port);
  const jobs = useJobs();
  const job = jobs.job;
  const [files,setFiles] = React.useState<File[]>([]);
  const [width,setWidth] = React.useState(1280); const [height,setHeight] = React.useState(720);
  const [busy,setBusy] = React.useState(false); const [message,setMessage] = React.useState(""); const [error,setError] = React.useState("");

  const refresh = React.useCallback(async () => { try { const [p,s] = await Promise.all([api<Peer[]>("/api/v1/peers"),api<{cloud_fallback_enabled:boolean;execution_mode:'mesh'|'cloud'}>("/api/v1/status")]); setPeers(p); setCloudEnabled(s.cloud_fallback_enabled); if (!modeBusyRef.current) setExecutionMode(s.execution_mode); } catch {} },[]);
  React.useEffect(() => { refresh(); const id=window.setInterval(refresh,1000); return()=>clearInterval(id); },[refresh]);

  const changeMode = async (next:'mesh'|'cloud') => {
    if (modeBusyRef.current || next === executionMode) return;
    if (next === 'cloud' && !window.confirm('Turn on Cloud mode? Every image in each new job will use AWS.')) return;
    modeBusyRef.current = true;
    setModeBusy(true); setModeError('');
    try { const result=await api<{execution_mode:'mesh'|'cloud'}>('/api/v1/execution-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({execution_mode:next})}); setExecutionMode(result.execution_mode); }
    catch(e){setModeError(e instanceof Error?e.message:'Could not change mode');}
    finally{modeBusyRef.current = false; setModeBusy(false); void refresh();}
  };

  const submit = async () => {
    if(!files.length) return; setBusy(true); setError(""); setMessage(`Uploading ${files.length} image${files.length===1?"":"s"}…`);
    const fd=new FormData(); files.forEach(f=>fd.append("images",f)); fd.append("max_width",String(width)); fd.append("max_height",String(height)); fd.append("submitted_from","web");
    try { const j=await api<Job>("/api/v1/jobs",{method:"POST",body:fd}); jobs.submitted(j); setMessage(`Job ${j.job_id} submitted in ${j.execution_mode} mode.`); }
    catch(e){setError(e instanceof Error?e.message:"Upload failed");} finally{setBusy(false);}
  };

  const online=peers.filter(p=>p.online); const done=job?.items.filter(i=>i.state==="completed").length??0; const processing=job?.items.filter(i=>i.state==="processing"||i.state==="retrying").length??0; const failed=job?.items.filter(i=>i.state==="failed").length??0; const retries=job?.items.reduce((a,i)=>a+Math.max(0,i.attempts.length-1),0)??0; const pct=job?.items.length?Math.round(done/job.items.length*100):0;

  return <main className="min-h-screen overflow-x-hidden bg-[#050607] text-white selection:bg-white/20">
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.07] bg-[#050607]/80 backdrop-blur-xl">
      <nav className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-4 md:px-8">
        <a href="#top" className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-white/[0.06] text-xs font-bold">EM</div><div><div className="text-sm font-semibold tracking-tight">Edge Mesh</div><div className="hidden text-[10px] uppercase tracking-[0.22em] text-slate-500 sm:block">Local compute network</div></div></a>
        <div className="hidden items-center gap-8 md:flex"><a href="#network" className="text-sm text-slate-400 transition hover:text-white">Network</a><a href="#workload" className="text-sm text-slate-400 transition hover:text-white">Workload</a><a href="#tasks" className="text-sm text-slate-400 transition hover:text-white">Tasks</a></div>
        <div className="flex flex-wrap items-center justify-end gap-2"><strong role="status" aria-live="polite" className="rounded-full border border-emerald-400/20 bg-emerald-400/5 px-3 py-1.5 text-xs text-emerald-300">{executionMode==='cloud'?'Cloud On':'Cloud Off'}</strong><Button type="button" size="sm" variant="outline" title={!localModeControl?'Open this dashboard on the coordinator at 127.0.0.1:5000 to change Cloud mode':!cloudEnabled&&executionMode==='mesh'?'AWS is unavailable on this coordinator':undefined} disabled={!localModeControl || modeBusy || (executionMode==='mesh' && !cloudEnabled)} onClick={()=>void changeMode(executionMode==='mesh'?'cloud':'mesh')}>{executionMode==='mesh'?'Turn Cloud On':'Turn Cloud Off'}</Button><Button size="sm" variant="outline" onClick={refresh} className="hidden sm:inline-flex"><RefreshCw className="h-3.5 w-3.5"/>Refresh</Button>{modeError&&<span role="alert" className="w-full text-right text-xs text-red-300">{modeError}</span>}</div>
        <button className="md:hidden" onClick={()=>setMobileMenuOpen(!mobileMenuOpen)}>{mobileMenuOpen?<X/>:<Menu/>}</button>
      </nav>
      {mobileMenuOpen&&<div className="border-t border-white/[0.07] bg-[#050607]/95 px-5 py-4 md:hidden"><div className="flex flex-col gap-4"><a href="#network" onClick={()=>setMobileMenuOpen(false)} className="text-sm text-slate-300">Network</a><a href="#workload" onClick={()=>setMobileMenuOpen(false)} className="text-sm text-slate-300">Workload</a><a href="#tasks" onClick={()=>setMobileMenuOpen(false)} className="text-sm text-slate-300">Tasks</a></div></div>}
    </header>

    <section id="top" className="relative mx-auto max-w-7xl px-5 pb-8 pt-28 md:px-8 md:pt-36">
      <div className="pointer-events-none absolute left-1/2 top-10 -z-10 h-80 w-[80%] -translate-x-1/2 rounded-full bg-white/[0.035] blur-3xl"/>
      <div className="mx-auto max-w-3xl text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs text-slate-400"><Zap className="h-3.5 w-3.5 text-slate-200"/>Distributed image processing on your LAN<ArrowUpRight className="h-3.5 w-3.5"/></div>
        <h1 className="text-4xl font-semibold tracking-[-0.04em] text-transparent sm:text-5xl md:text-7xl" style={{backgroundImage:"linear-gradient(to bottom,#fff 10%,#fff 48%,rgba(255,255,255,.48))",WebkitBackgroundClip:"text"}}>Turn nearby laptops into one compute mesh.</h1>
        <p className="mx-auto mt-6 max-w-2xl text-sm leading-6 text-slate-400 md:text-base">Upload a batch once. Choose Mesh for nearby laptops and phone workers, or Cloud to send every image directly to AWS.</p>
      </div>

      <div className="mt-14 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <div id="workload" className="rounded-2xl border border-white/10 bg-white/[0.035] p-5 shadow-2xl shadow-black/20 md:p-7">
          <div className="mb-6 flex items-start justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">01 / New job</p><h2 className="mt-2 text-xl font-semibold">Resize a batch</h2><p className="mt-1 text-sm text-slate-500">New jobs use the selected mode: Mesh workers or direct AWS.</p></div><div className="rounded-xl border border-white/10 bg-white/[0.04] p-3"><Upload className="h-5 w-5 text-slate-300"/></div></div>
          <label className="group flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-10 text-center transition hover:border-white/20 hover:bg-white/[0.025]"><input className="hidden" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e=>setFiles(Array.from(e.target.files||[]))}/><div className="mb-3 grid h-12 w-12 place-items-center rounded-xl border border-white/10 bg-white/[0.04]"><FileImage className="h-5 w-5 text-slate-300"/></div><strong className="text-sm">{files.length?`${files.length} image${files.length===1?"":"s"} selected`:"Choose JPEG, PNG, or WebP images"}</strong><span className="mt-1 text-xs text-slate-500">Up to 100 images · 100 MB total</span></label>
          <div className="mt-5 grid grid-cols-2 gap-3"><label className="text-xs text-slate-500">Maximum width<input value={width} onChange={e=>setWidth(Number(e.target.value))} type="number" min="1" max="10000" className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-white/25"/></label><label className="text-xs text-slate-500">Maximum height<input value={height} onChange={e=>setHeight(Number(e.target.value))} type="number" min="1" max="10000" className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-white/25"/></label></div>
          <Button className="mt-5 w-full" size="lg" variant="gradient" disabled={!files.length||busy} onClick={submit}>{busy?<Loader2 className="h-4 w-4 animate-spin"/>:<Network className="h-4 w-4"/>}{busy?"Submitting…":"Distribute job"}<ArrowUpRight className="h-4 w-4"/></Button>
          {(message||error)&&<div className={cn("mt-3 rounded-lg border px-3 py-2 text-xs",error?"border-red-400/20 bg-red-400/5 text-red-300":"border-white/10 bg-white/[0.03] text-slate-400")}>{error||message}</div>}
        </div>

        <div id="network" className="rounded-2xl border border-white/10 bg-white/[0.035] p-5 md:p-7">
          <div className="mb-6 flex items-start justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">02 / Network</p><h2 className="mt-2 text-xl font-semibold">Live nodes</h2></div><div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-400">{online.length} online</div></div>
          <div className="space-y-3">{peers.length===0?<div className="rounded-xl border border-white/10 bg-black/20 p-6 text-center text-sm text-slate-500">Waiting for LAN nodes…</div>:peers.map(p=><div key={p.node_id} className={cn("rounded-xl border p-4 transition",p.online?"border-white/10 bg-black/20":"border-red-400/10 bg-red-400/[0.02]")}><div className="flex items-center justify-between"><div className="flex items-center gap-3"><span className={cn("h-2 w-2 rounded-full",p.online?"bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.75)]":"bg-red-400")}/><div><div className="text-sm font-medium">{p.name||p.display_name}</div><div className="mt-0.5 text-[11px] text-slate-500">{p.source||"LAN peer"} · {p.online?"Online":"Offline"}</div></div></div><Server className="h-4 w-4 text-slate-600"/></div><div className="mt-4 grid grid-cols-3 gap-2 text-[11px]"><div className="rounded-lg bg-white/[0.03] p-2"><span className="text-slate-600">CPU</span><div className="mt-1 font-medium text-slate-300">{Math.round(p.cpu_percent||0)}%</div></div><div className="rounded-lg bg-white/[0.03] p-2"><span className="text-slate-600">Memory</span><div className="mt-1 font-medium text-slate-300">{Math.round(p.free_memory_mb||0)} MB</div></div><div className="rounded-lg bg-white/[0.03] p-2"><span className="text-slate-600">RTT</span><div className="mt-1 font-medium text-slate-300">{Math.round(p.rtt_ms||0)} ms</div></div></div></div>)}</div>
          <div className="mt-5 flex gap-2 rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-slate-500"><Wifi className="mt-0.5 h-4 w-4 shrink-0"/>mDNS discovery is automatic. Use <code className="text-slate-300">--peer IP:PORT</code> when multicast is blocked.</div>
        </div>
      </div>
    </section>

    <section id="tasks" className="mx-auto max-w-7xl px-5 pb-10 md:px-8">
      <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-5 md:p-7">
        <div className="mb-6 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><label htmlFor="job-selector" className="text-sm font-medium text-slate-200">Recent jobs from all devices</label><Button size="sm" variant="outline" onClick={jobs.refresh}><RefreshCw className="h-3.5 w-3.5"/>Refresh jobs</Button></div>
          <select id="job-selector" aria-label="Recent jobs" value={jobs.selectedId} onChange={event=>jobs.select(event.target.value)} className="mt-3 min-h-11 w-full rounded-lg border border-white/15 bg-[#101418] px-3 text-sm text-slate-200">
            {!jobs.selectedId&&<option value="">{jobs.recent.length?"Choose a job":"No jobs in this coordinator session"}</option>}
            {jobs.selectedId&&!jobs.recent.some(row=>row.job_id===jobs.selectedId)&&<option value={jobs.selectedId}>#{jobs.selectedId} · Selected older or unavailable job</option>}
            {jobs.recent.map(row=><option key={row.job_id} value={row.job_id}>#{row.job_id} · {sourceLabel(row.submitted_from)} · {row.execution_mode?.toUpperCase()||'MESH'} · {row.status} · {row.completed_count}/{row.item_count} completed · {new Date(row.created_at*1000).toLocaleString()}</option>)}
          </select>
          <p className="mt-2 text-xs text-slate-400" aria-live="polite">{jobs.hasNew?"New jobs available. Choose one from the list; your current selection is preserved.":"Phone and browser submissions appear automatically. Latest 50 jobs; history resets when the coordinator restarts."}</p>
          {(jobs.listError||jobs.detailError)&&<p role="alert" className="mt-3 text-sm text-red-300">{jobs.listError||jobs.detailError}</p>}
          {job&&<p className="mt-3 text-xs text-slate-400" data-testid="selected-job">Viewing #{job.job_id} · {sourceLabel(job.submitted_from)} · {job.execution_mode?.toUpperCase()||'MESH'} mode · {new Date(job.created_at*1000).toLocaleString()}</p>}
        </div>
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">03 / Job monitor</p><div className="mt-2 flex flex-wrap items-center gap-3"><h2 className="text-xl font-semibold">Current workload</h2><span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{job?.status||"idle"}</span></div><p className="mt-1 text-sm text-slate-500">{job?`${job.items.length} images · ${job.max_width} × ${job.max_height}${job.duration!=null?` · ${job.duration}s`:""}`:"No job submitted yet"}</p></div><div className="flex items-center gap-3"><span className="text-3xl font-semibold tracking-tight">{pct}%</span>{job&&(job.status==="completed"||job.status==="failed")&&done>0?<a href={`/api/v1/jobs/${job.job_id}/download`} className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-xs font-medium text-white hover:bg-white/[0.08]"><Download className="h-4 w-4"/>Download ZIP</a>:null}</div></div>
        {job?.s3_result&&<p role={job.s3_result.status==='failed'?'alert':'status'} className={cn("mt-3 break-all text-xs",job.s3_result.status==='failed'?'text-red-300':'text-slate-400')}>{job.s3_result.status==='saved'?`Saved to s3://${job.s3_result.bucket}/${job.s3_result.key}`:job.s3_result.status==='failed'?job.s3_result.error:job.s3_result.status==='skipped'?job.s3_result.error:'Saving results ZIP to S3…'}</p>}
        <div className="mt-6 h-2 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-gradient-to-r from-white/80 to-white/35 transition-all duration-500" style={{width:`${pct}%`}}/></div>
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4"><Metric icon={<CheckCircle2/>} value={done} label="Completed"/><Metric icon={<Activity/>} value={processing} label="Processing"/><Metric icon={<RefreshCw/>} value={retries} label="Retries"/><Metric icon={<XCircle/>} value={failed} label="Failed"/></div>
        {job&&<div className="mt-6 overflow-hidden rounded-xl border border-white/10">
          <div className="grid grid-cols-[1.6fr_.8fr_1fr_.5fr_.8fr] border-b border-white/10 bg-white/[0.025] px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-slate-600"><span>Image</span><span>State</span><span>Assigned node</span><span>Try</span><span>Output</span></div>
          <div className="divide-y divide-white/[0.06]">{job.items.map(i=><div key={i.id} className="px-4 py-3 text-xs">
            <div className="grid grid-cols-[1.6fr_.8fr_1fr_.5fr_.8fr] items-center">
              <div className="min-w-0"><div className="truncate font-medium text-slate-300">{i.source_name}</div><div className="mt-0.5 text-[10px] text-slate-600">{fmtBytes(i.bytes)}</div></div>
              <span className={cn("flex items-center gap-1.5 capitalize",i.state==="completed"?"text-emerald-300":i.state==="failed"?"text-red-300":i.state==="processing"||i.state==="retrying"?"text-amber-300":"text-slate-500")}>{stateIcon(i.state)}{i.state}</span>
              <span className="truncate text-slate-500">{i.assigned_node||"Waiting"}{i.execution_location&&<span className="block text-[10px] uppercase text-slate-600">{i.execution_location}</span>}</span>
              <span className="text-slate-500">{i.attempts.length}</span><span className="text-slate-500">{i.output_size?i.output_size.join(" × "):"—"}</span>
            </div>
            <AttemptDetails item={i}/>
          </div>)}</div>
        </div>}
        {!job&&<div className="mt-6 rounded-xl border border-dashed border-white/10 bg-black/20 py-14 text-center text-sm text-slate-500">{jobs.detailError?"Select another job or use Refresh jobs to retry.":jobs.selectedId?"Loading the selected job…":"Submit from this browser or your phone to see jobs here."}</div>}
      </div>
    </section>

    <footer className="mx-auto flex max-w-7xl flex-col gap-2 border-t border-white/[0.06] px-5 py-6 text-[11px] text-slate-600 sm:flex-row sm:justify-between md:px-8"><span>Edge Mesh v1.1</span><span className="flex items-center gap-2"><ShieldCheck className="h-3.5 w-3.5"/>Mesh or direct AWS · Temporary cloud staging</span></footer>
  </main>;
}
function AttemptDetails({item}:{item:Item}) {
  return <>
    {item.error&&<p role="alert" className="mt-2 break-words text-red-300">{item.error}</p>}
    {item.attempts.length>0&&<details className="mt-2 text-slate-400">
      <summary className="cursor-pointer">Attempt details ({item.attempts.length})</summary>
      <ol className="mt-2 space-y-2">{item.attempts.map((attempt,index)=><li key={index} className="break-words">
        {index+1}. {attempt.node} · {attempt.status}{attempt.duration_ms!=null?` · ${attempt.duration_ms} ms`:""}
        {attempt.error&&<p className="mt-1 text-red-300">{attempt.error}</p>}
      </li>)}</ol>
    </details>}
  </>;
}
function Metric({icon,value,label}:{icon:React.ReactElement<{className?:string}>;value:number;label:string}){return <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="mb-3 text-slate-600">{React.cloneElement(icon,{className:"h-4 w-4"})}</div><div className="text-2xl font-semibold tracking-tight">{value}</div><div className="mt-1 text-[11px] text-slate-600">{label}</div></div>}
