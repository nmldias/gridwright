import type { Proposal, ServerPython } from '../api/client';
import { create } from 'zustand';
import type { CellRef, CellView, Chart, NamedRange, TableId, TableMeta, Trace } from '../engine/types';

export interface Selection {
  table: TableId;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  /** active (focused) cell */
  ar: number;
  ac: number;
}

export interface Editing {
  table: TableId;
  r: number;
  c: number;
  /** text the editor started with */
  initial: string;
  /** true when the editor was opened by typing a character (replace mode) */
  replace: boolean;
  /** which widget owns the keyboard focus */
  source?: 'cell' | 'bar';
}

export type Panel = 'none' | 'code' | 'ai' | 'sql' | 'files' | 'share' | 'table' | 'settings' | 'history' | 'format' | 'chart' | 'review' | 'navigate';

export interface Presence {
  id: string;
  name: string;
  color: string;
  login?: string;
  table?: TableId;
  r?: number;
  c?: number;
}

export interface CodeRunState {
  running: boolean;
  startedAt: number;
}

export interface Me {
  login: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  identity: boolean;
}

/** What the current user may do with the open document (server-side sharing). */
export type Permission = 'none' | 'view' | 'sign' | 'edit' | 'own';

export interface TraceState extends Trace {
  cell: CellRef;
}

export interface FilterPopover {
  table: TableId;
  col: number;
  x: number;
  y: number;
}

interface State {
  ready: boolean;
  fileId: string | null;
  fileName: string;
  dirty: boolean;
  tables: Map<TableId, TableMeta>;
  cells: Map<TableId, Map<number, CellView>>;
  /** bumped on every change to the cell maps (inner maps are patched in place) */
  cellsVersion: number;
  names: NamedRange[];
  selection: Selection | null;
  selectedTable: TableId | null;
  editing: Editing | null;
  editorText: string;
  panel: Panel;
  codeCell: CellRef | null;
  canUndo: boolean;
  canRedo: boolean;
  status: string;
  presence: Map<string, Presence>;
  runs: Map<string, CodeRunState>;
  zoom: number;
  pythonStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** server-side Python as reported by /api/health (null = not available) */
  serverPython: ServerPython | null;
  me: Me;
  /** last log position applied from the server (0 = none) */
  seq: number;
  /** cell whose history the History panel shows */
  historyCell: CellRef | null;
  filterPopover: FilterPopover | null;
  touch: boolean;
  charts: Chart[];
  selectedChart: number | null;
  /** precedents/dependents overlay of a cell (Review panel) */
  trace: TraceState | null;
  /** sharing level of the open document */
  permission: Permission;
  fileFolder: string;
  /** bumped when a code-cell run record is added (Review panel) */
  runsVersion: number;
  /** bumped when the server reports a proposal filed or decided */
  proposalsVersion: number;
  /** proposals of the open document, as last loaded from the server (see ui/proposals.ts) */
  proposals: Proposal[];
  /** a save is in flight */
  saving: boolean;
  /** when the open document was last saved to the server in this session (ms), null = never */
  savedAt: number | null;
  /** side panel width in px (desktop) */
  panelWidth: number;
  /** grid text density */
  density: 'comfortable' | 'compact';
  /** the start card (first use: import, template, blank, example) */
  start: boolean;
  /** what the Files panel shows */
  filesView: 'documents' | 'templates';
  /** open companion issues needing attention (the Ask badge) */
  attention: number;
  /** bumped when the server says the companion re-checked the document */
  companionVersion: number;
  set: (patch: Partial<State>) => void;
}

export const useStore = create<State>((set) => ({
  ready: false,
  fileId: null,
  fileName: 'Untitled',
  dirty: false,
  tables: new Map(),
  cells: new Map(),
  cellsVersion: 0,
  names: [],
  selection: null,
  selectedTable: null,
  editing: null,
  editorText: '',
  panel: 'none',
  codeCell: null,
  canUndo: false,
  canRedo: false,
  status: '',
  presence: new Map(),
  runs: new Map(),
  zoom: 1,
  pythonStatus: 'idle',
  serverPython: null,
  me: { login: '', name: '', role: 'admin', identity: false },
  seq: 0,
  historyCell: null,
  filterPopover: null,
  charts: [],
  selectedChart: null,
  trace: null,
  permission: 'own',
  fileFolder: '',
  runsVersion: 0,
  proposalsVersion: 0,
  proposals: [],
  saving: false,
  savedAt: null,
  panelWidth: (() => {
    try {
      const v = Number(localStorage.getItem('gridwright.panelWidth'));
      return v >= 320 && v <= 900 ? v : 420;
    } catch {
      return 420;
    }
  })(),
  density: (() => {
    try {
      return localStorage.getItem('gridwright.density') === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  })(),
  start: false,
  filesView: 'documents',
  attention: 0,
  companionVersion: 0,
  touch: typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) && !matchMedia('(pointer: fine)').matches,
  set: (patch) => set(patch),
}));

export const getState = () => useStore.getState();

export function cellAt(table: TableId, r: number, c: number): CellView | undefined {
  return getState().cells.get(table)?.get(r * 65536 + c);
}

/** True when the open document cannot be edited by this user. */
export function readOnly(): boolean {
  const st = getState();
  return st.me.role === 'viewer' || st.permission === 'view' || st.permission === 'sign' || st.permission === 'none';
}

export function setStatus(msg: string, ms = 4000) {
  useStore.setState({ status: msg });
  if (ms > 0) {
    window.setTimeout(() => {
      if (useStore.getState().status === msg) useStore.setState({ status: '' });
    }, ms);
  }
}
