import { useEffect, useState } from 'react';
import { api } from './api/client';
import { joinFile } from './api/ws';
import * as book from './engine/book';
import { GridCanvas } from './grid/GridCanvas';
import { useStore } from './state/store';
import { AiPanel } from './ui/AiPanel';
import { AdminPanel } from './ui/AdminPanel';
import { ChartPanel } from './ui/ChartPanel';
import { CodePanel } from './ui/CodePanel';
import { ReviewPanel } from './ui/ReviewPanel';
import { FilesPanel } from './ui/FilesPanel';
import { FormatPanel } from './ui/FormatPanel';
import { FormulaBar } from './ui/FormulaBar';
import { HistoryPanel } from './ui/HistoryPanel';
import { SettingsPanel, prewarmEnabled } from './ui/SettingsPanel';
import { SharePanel } from './ui/SharePanel';
import { NavigatePanel } from './ui/NavigatePanel';
import { StartCard } from './ui/StartCard';
import { SidePanel } from './ui/SidePanel';
import { loadProposals } from './ui/proposals';
import { loadCompanion } from './ui/companion';
import { loadConversation } from './ui/chat';
import { loadPendingIntakes } from './ui/intake';
import { SqlPanel } from './ui/SqlPanel';
import { StatusBar } from './ui/StatusBar';
import { TablePanel } from './ui/TablePanel';
import { TopBar } from './ui/TopBar';
import { installAutosave, openFile, saveCurrentFile } from './ui/files';
import { getPyWorker, installRefreshScheduler, installRunner, setLocalPyodide } from './workers/runner';
import { setGridFontSize } from './grid/renderer';
import { getRenderer } from './grid/actions';
import { THEME } from './theme';

const SAMPLE: string[][] = [
  ['Region', 'Units', 'Unit price', 'Revenue'],
  ['North', '120', '9.5', '=B2*C2'],
  ['South', '80', '11', '=B3*C3'],
  ['East', '150', '8.75', '=B4*C4'],
  ['West', '60', '12.25', '=B5*C5'],
  ['Total', '=SUM(B2:B5)', '', '=SUM(D2:D5)'],
];

const INITIAL_FILE = new URLSearchParams(location.search).get('file');
let booted = false;

export function App() {
  const ready = useStore((s) => s.ready);
  const panel = useStore((s) => s.panel);
  const start = useStore((s) => s.start && !s.fileId && !s.dirty);
  const [boot, setBoot] = useState<string>('loading engine…');

  useEffect(() => {
    // grid density: the renderer's text size follows the setting
    setGridFontSize(THEME.gridFont[useStore.getState().density]);
    const offDensity = useStore.subscribe((s, prev) => {
      if (s.density !== prev.density) {
        setGridFontSize(THEME.gridFont[s.density]);
        getRenderer()?.markDirty();
      }
      // the start card is for a fresh document only
      if (s.start && (s.dirty || s.fileId)) useStore.setState({ start: false });
    });
    const offRunner = installRunner();
    const offAutosave = installAutosave();
    const offRefresh = installRefreshScheduler();
    const firstBoot = !booted;
    booted = true;
    if (firstBoot) (async () => {
      try {
        await book.ensureEngine();
        // server capabilities first: a local Pyodide changes the default runtime URL
        try {
          const h = await api.health();
          setLocalPyodide(!!h.pyodide);
          useStore.setState({ serverPython: h.python ? { ...h.python, agent: !!h.investigation } : null });
          if (h.identity) {
            const me = await api.me();
            useStore.setState({ me });
          }
        } catch {
          useStore.setState({ status: 'Server not reachable — files, SQL and AI are unavailable; the spreadsheet still works.' });
        }
        const fileId = INITIAL_FILE;
        if (fileId) {
          await openFile(fileId);
        } else {
          await book.loadBook(null, 'Untitled');
          // seed the first table so the canvas is not empty
          const first = useStore.getState().tables.keys().next().value;
          if (first) {
            book.apply({ type: 'set_cells', table: first, row: 0, col: 0, values: SAMPLE });
            useStore.setState({ dirty: false });
          }
          joinFile(null);
          // first use: offer import, a template or a blank sheet; the example is already on the canvas
          useStore.setState({ start: true });
        }
        if (prewarmEnabled()) getPyWorker();
      } catch (e) {
        setBoot(`Failed to start: ${(e as Error).message}`);
      }
    })();
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveCurrentFile();
      }
    };
    window.addEventListener('keydown', onKey);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      offDensity();
      offRunner();
      offAutosave();
      offRefresh();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  // keep ?file= in the URL in sync with the open document
  const fileId = useStore((s) => s.fileId);
  const proposalsVersion = useStore((s) => s.proposalsVersion);
  const companionVersion = useStore((s) => s.companionVersion);
  useEffect(() => {
    void loadProposals();
  }, [fileId, proposalsVersion]);
  useEffect(() => {
    if (fileId) void loadCompanion(fileId);
    else useStore.setState({ attention: 0 });
  }, [fileId, companionVersion]);
  useEffect(() => {
    if (fileId) void loadConversation(fileId);
  }, [fileId]);
  useEffect(() => {
    if (fileId) void loadPendingIntakes(fileId);
  }, [fileId, companionVersion]);
  useEffect(() => {
    const url = new URL(location.href);
    if (fileId) url.searchParams.set('file', fileId);
    else url.searchParams.delete('file');
    history.replaceState(null, '', url.toString());
  }, [fileId]);

  if (!ready) {
    return (
      <div className="boot">
        <div className="logo big">▦</div>
        <div>{boot}</div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar />
      <FormulaBar />
      <div className="main">
        <GridCanvas />
        {start && panel !== 'admin' && <StartCard />}
        {panel !== 'none' && (
          <SidePanel>
            {panel === 'code' && <CodePanel />}
            {panel === 'ai' && <AiPanel />}
            {panel === 'sql' && <SqlPanel />}
            {panel === 'files' && <FilesPanel />}
            {panel === 'share' && <SharePanel />}
            {panel === 'navigate' && <NavigatePanel />}
            {panel === 'table' && <TablePanel />}
            {panel === 'format' && <FormatPanel />}
            {panel === 'history' && <HistoryPanel />}
            {panel === 'chart' && <ChartPanel />}
            {panel === 'review' && <ReviewPanel />}
            {panel === 'settings' && <SettingsPanel />}
            {panel === 'admin' && <AdminPanel />}
          </SidePanel>
        )}
      </div>
      <StatusBar />
    </div>
  );
}
