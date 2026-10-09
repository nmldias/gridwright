import { create } from 'zustand';
import type { CellRef, CellView, NamedRange, TableId, TableMeta } from '../engine/types';

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

export type Panel = 'none' | 'code' | 'ai' | 'sql' | 'files' | 'table' | 'settings' | 'history' | 'format';

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
  me: Me;
  /** last log position applied from the server (0 = none) */
  seq: number;
  /** cell whose history the History panel shows */
  historyCell: CellRef | null;
  filterPopover: FilterPopover | null;
  touch: boolean;
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
  me: { login: '', name: '', role: 'admin', identity: false },
  seq: 0,
  historyCell: null,
  filterPopover: null,
  touch: typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) && !matchMedia('(pointer: fine)').matches,
  set: (patch) => set(patch),
}));

export const getState = () => useStore.getState();

export function cellAt(table: TableId, r: number, c: number): CellView | undefined {
  return getState().cells.get(table)?.get(r * 65536 + c);
}

export function setStatus(msg: string, ms = 4000) {
  useStore.setState({ status: msg });
  if (ms > 0) {
    window.setTimeout(() => {
      if (useStore.getState().status === msg) useStore.setState({ status: '' });
    }, ms);
  }
}
