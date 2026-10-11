// The state of one dataset in the studio: its file, profile and proposal, the steps being prepared
// (saved as the draft and previewed on a sample after every change), the active job, and the run.
import { useCallback, useEffect, useRef, useState } from 'react';
import { datasets, type AssistAction, type DatasetMeta, type Job, type Proposal, type Roles, type RunMeta, type RunOutput, type SheetProfile, type Step } from '../../api/datasets';
import { useStore } from '../../state/store';
import { useJob } from './common';

export interface Model {
  id: string;
  meta: DatasetMeta | null;
  profiles: SheetProfile[];
  proposal: Proposal | null;
  error: string | null;
  canEdit: boolean;
  steps: Step[];
  roles: Roles;
  recipe?: { id: string; version: number };
  setSteps: (steps: Step[], why?: string) => void;
  useRecipe: (steps: Step[], roles: Roles, recipe: { id: string; version: number }) => void;
  applyAction: (a: AssistAction) => string | null;
  undo: (() => void) | null;
  preview: RunOutput | null;
  previewing: boolean;
  previewError: string | null;
  job: Job | null;
  jobKind: Job['kind'] | null;
  run: RunMeta | null;
  selectRun: (id: string) => void;
  runAll: (onDone?: (j: Job) => void) => Promise<void>;
  reload: () => Promise<void>;
  setJob: (id: string, kind: Job['kind'], onDone?: (j: Job) => void) => void;
}

const OUTPUT_TYPES = new Set(['table', 'pivot', 'ageing', 'exceptions']);

export function useDataset(id: string): Model {
  const role = useStore((s) => s.me.role);
  const canEdit = role !== 'viewer';
  const [meta, setMeta] = useState<DatasetMeta | null>(null);
  const [profiles, setProfiles] = useState<SheetProfile[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [steps, setStepsState] = useState<Step[]>([]);
  const [roles, setRoles] = useState<Roles>({});
  const [recipe, setRecipe] = useState<{ id: string; version: number } | undefined>();
  const [history, setHistory] = useState<Step[][]>([]);
  const [preview, setPreview] = useState<RunOutput | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobKind, setJobKind] = useState<Job['kind'] | null>(null);
  const [run, setRun] = useState<RunMeta | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | null>(null);
  const jobDone = useRef<((j: Job) => void) | undefined>();
  const runRef = useRef<RunMeta | null>(null);
  runRef.current = run;

  const loadRun = useCallback(
    async (runId: string) => {
      try {
        const { run: r } = await datasets.runMeta(id, runId);
        setRun(r);
      } catch {
        setRun(null);
      }
    },
    [id],
  );

  const reload = useCallback(async () => {
    try {
      const d = await datasets.get(id);
      setMeta(d.dataset);
      setProfiles(d.profiles ?? []);
      setProposal(d.proposal);
      setError(null);
      const active = d.jobs.find((j) => j.status === 'queued' || j.status === 'running');
      if (active) {
        setJobKind(active.kind);
        setJobId(active.id);
      }
      if (d.dataset.status === 'ready') {
        const s = d.dataset.draft?.steps ?? d.proposal?.steps ?? [];
        setStepsState((cur) => (cur.length ? cur : s));
        setRoles((cur) => (Object.keys(cur).length ? cur : (d.dataset.draft?.roles ?? d.proposal?.roles ?? {})));
        setRecipe((cur) => cur ?? d.dataset.draft?.recipe);
        // the newest run, unless one of this dataset's runs is already shown
        const latest = d.dataset.runs[0];
        const shown = runRef.current;
        if (latest && (!shown || !d.dataset.runs.some((r) => r.id === shown.id))) void loadRun(latest.id);
      }
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    setMeta(null);
    setStepsState([]);
    setRoles({});
    setRecipe(undefined);
    setPreview(null);
    setRun(null);
    setHistory([]);
    void reload();
  }, [id, reload]);

  const job = useJob(jobId, (j) => {
    setJobId(null);
    setJobKind(null);
    const cb = jobDone.current;
    jobDone.current = undefined;
    void reload().then(() => {
      if (j.kind === 'run' && j.status === 'done' && j.result && typeof (j.result as { run?: string }).run === 'string') void loadRun((j.result as { run: string }).run);
      cb?.(j);
    });
  });

  // preview on a sample after every change (debounced), and keep the draft on the server
  const schedule = useCallback(
    (next: Step[], nextRoles: Roles, nextRecipe?: { id: string; version: number }) => {
      if (!canEdit || !next.length) return;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(async () => {
        const my = ++seq.current;
        setPreviewing(true);
        try {
          const p = await datasets.preview(id, next);
          if (my !== seq.current) return;
          setPreview(p);
          setPreviewError(null);
        } catch (e) {
          if (my === seq.current) setPreviewError((e as Error).message);
        } finally {
          if (my === seq.current) setPreviewing(false);
        }
        datasets.saveDraft(id, next, nextRoles, nextRecipe).catch(() => undefined);
      }, 450);
    },
    [id, canEdit],
  );
  useEffect(() => {
    if (meta?.status === 'ready' && steps.length && !preview && !previewing) schedule(steps, roles, recipe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.status, steps.length]);

  const setSteps = useCallback(
    (next: Step[]) => {
      setHistory((h) => [...h.slice(-30), steps]);
      setStepsState(next);
      schedule(next, roles, recipe);
    },
    [steps, roles, recipe, schedule],
  );
  const undo = history.length
    ? () => {
        const prev = history[history.length - 1];
        setHistory((h) => h.slice(0, -1));
        setStepsState(prev);
        schedule(prev, roles, recipe);
      }
    : null;
  const useRecipe = (s: Step[], r: Roles, rec: { id: string; version: number }) => {
    setHistory((h) => [...h.slice(-30), steps]);
    setStepsState(s);
    setRoles(r);
    setRecipe(rec);
    schedule(s, r, rec);
  };

  /** add, change or remove a step (from the assistant, an insight or a hand edit); null when applied */
  const applyAction = (a: AssistAction): string | null => {
    if (a.error) return a.error;
    const list = [...steps];
    if (a.op === 'remove') {
      const i = list.findIndex((s) => s.id === a.id);
      if (i <= 0) return 'that step is not in the list (the first step cannot be removed)';
      list.splice(i, 1);
    } else if (a.op === 'update') {
      const i = list.findIndex((s) => s.id === (a.id ?? a.step?.id));
      if (i < 0 || !a.step) return 'that step is not in the list';
      list[i] = { ...a.step, id: list[i].id };
    } else if (a.step) {
      if (list.some((s) => s.id === a.step!.id)) return 'that step is already in the list';
      let at = a.after ? list.findIndex((s) => s.id === a.after) + 1 : 0;
      if (at <= 0) {
        // no anchor: a cleaning or check step goes before the first output, an output at the end
        const first = list.findIndex((s) => OUTPUT_TYPES.has(s.type));
        at = OUTPUT_TYPES.has(a.step.type) || first < 0 ? list.length : first;
      }
      list.splice(at, 0, a.step);
    } else return 'nothing to apply';
    setSteps(list);
    return null;
  };

  const runAll = async (onDone?: (j: Job) => void) => {
    const { job: j } = await datasets.run(id, steps, roles, recipe);
    jobDone.current = onDone;
    setJobKind('run');
    setJobId(j.id);
  };
  const setJob = (jid: string, kind: Job['kind'], onDone?: (j: Job) => void) => {
    jobDone.current = onDone;
    setJobKind(kind);
    setJobId(jid);
  };

  return {
    id,
    meta,
    profiles,
    proposal,
    error,
    canEdit,
    steps,
    roles,
    recipe,
    setSteps,
    useRecipe,
    applyAction,
    undo,
    preview,
    previewing,
    previewError,
    job,
    jobKind,
    run,
    selectRun: (r) => void loadRun(r),
    runAll,
    reload,
    setJob,
  };
}
