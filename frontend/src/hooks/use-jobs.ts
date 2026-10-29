import { useCallback, useEffect, useRef, useState } from 'react';

export type Job = {
  job_id: string; created_at: number; submitted_from?: string; execution_mode: 'mesh' | 'cloud';
  max_width: number; max_height: number; status: string; duration?: number | null; error?: string | null;
  node_contributions?: Record<string, number>;
  s3_result?: { status: 'pending'|'uploading'|'saved'|'failed'|'skipped'; bucket?: string|null; key?: string|null; error?: string|null } | null;
  items: Array<{ id: string; source_name: string; bytes: number; state: string;
    attempts: Array<{ node: string; status: string; duration_ms?: number; error?: string }>;
    assigned_node?: string | null; execution_location?: string | null;
    output_size?: number[] | null; processing_ms?: number | null; error?: string | null }>;
};
export type JobSummary = {
  job_id: string; created_at: number; submitted_from: string; status: string; execution_mode: 'mesh' | 'cloud';
  item_count: number; completed_count: number; failed_count: number;
};
const terminal = (status: string) => ['completed', 'failed'].includes(status);
export const sourceLabel = (source?: string) => source === 'mobile' ? 'Phone' : source === 'web' ? 'Browser' : 'Unknown source';

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(response.status === 404
    ? url === '/api/v1/jobs' ? 'Job discovery unavailable. Restart the updated coordinator.' : 'Job unavailable. The coordinator may have restarted; choose another job.'
    : `Could not refresh jobs (${response.status}). Retrying…`);
  return response.json();
}

export function useJobs() {
  const [recent, setRecent] = useState<JobSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [hasNew, setHasNew] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const selectedRef = useRef('');
  const seen = useRef<Set<string> | null>(null);

  const select = useCallback((id: string, seed?: Job) => {
    selectedRef.current = id;
    setSelectedId(id);
    setJob(seed || null);
    setDetailError('');
    setHasNew(false);
  }, []);
  const refresh = useCallback(() => setRefreshVersion(value => value + 1), []);
  const submitted = useCallback((created: Job) => {
    select(created.job_id, created);
    refresh();
  }, [select, refresh]);

  // Discovery is independent of peer discovery and never overlaps its own requests.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await read<{ jobs: JobSummary[] }>('/api/v1/jobs', controller.signal);
        if (controller.signal.aborted) return;
        setRecent(result.jobs);
        setListError('');
        if (seen.current && result.jobs.some(row => !seen.current!.has(row.job_id) && row.job_id !== selectedRef.current)) setHasNew(true);
        seen.current = new Set(result.jobs.map(row => row.job_id));
        if (!selectedRef.current && result.jobs.length) select(result.jobs[0].job_id);
      } catch (error) {
        if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : 'Job discovery failed. Retrying…');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [select, refreshVersion]);

  const summary = recent.find(row => row.job_id === selectedId);
  const missing = !!selectedId && !summary;
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await read<Job>(`/api/v1/jobs/${selectedId}`, controller.signal);
        if (controller.signal.aborted || selectedRef.current !== selectedId) return;
        setJob(result);
        setDetailError('');
        if (!terminal(result.status) || ['pending','uploading'].includes(result.s3_result?.status || '')) timer = setTimeout(poll, 1000);
      } catch (error) {
        if (controller.signal.aborted || selectedRef.current !== selectedId) return;
        const text = error instanceof Error ? error.message : 'Could not load job details.';
        setDetailError(text);
        if (text.startsWith('Job unavailable')) setJob(null);
        else timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selectedId, summary?.status, summary?.completed_count, summary?.failed_count, missing, missing ? recent[0]?.job_id : undefined, refreshVersion]);

  return { recent, selectedId, job, select, submitted, refresh, hasNew, listError, detailError };
}
