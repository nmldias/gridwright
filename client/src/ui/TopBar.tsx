import { type ReactNode, useEffect, useState } from 'react';
import { api, type FileInfo } from '../api/client';
import { accounts } from '../api/accounts';
import { setCurrentTenant, switchTenant } from '../api/tenant';
import * as book from '../engine/book';
import { isCodeKind, type CellKind } from '../engine/types';
import { addTable, applyFormat, autoFitColumns, makeAgentCell, makeCodeCell, toggleBold } from '../grid/actions';
import { NUMBER_FORMATS } from '../grid/format';
import { useStore, type Panel } from '../state/store';
import { downloadJson, newFile, openFile, saveCurrentFile } from './files';
import { pickAndImport } from './import';
import { Menu, type MenuEntry } from './Menu';
import { openPrintView } from './print';
import { insertChart } from './review';
import { exportWorkbookXlsx } from './xlsx';

const FILLS = ['', '#fef3c7', '#dcfce7', '#dbeafe', '#fce7f3', '#f3f4f6', '#fee2e2'];
const COLORS = ['', '#111827', '#b91c1c', '#1d4ed8', '#047857', '#6b7280', '#7c3aed'];
const KIND_LABEL: Partial<Record<CellKind, string>> = { python: 'Python', javascript: 'JavaScript', sql: 'SQL' };

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The primary bar: document · Save · Add · Python · Ask · Review · Share. Everything else is
 * contextual — Format appears with a selection, Chart with a selected chart — or lives under More.
 * A reader who cannot edit sees only what they can use.
 */
export function TopBar() {
  const fileId = useStore((s) => s.fileId);
  const fileName = useStore((s) => s.fileName);
  const dirty = useStore((s) => s.dirty);
  const saving = useStore((s) => s.saving);
  const savedAt = useStore((s) => s.savedAt);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const panel = useStore((s) => s.panel);
  const me = useStore((s) => s.me);
  const touchDevice = useStore((s) => s.touch);
  // the bar hides Add, Python, Share, Undo and Redo under the same query as the stylesheet (phones, narrow windows): More carries them then
  const compactQuery = '(max-width: 760px), (pointer: coarse)';
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia(compactQuery).matches);
  useEffect(() => {
    const mq = window.matchMedia(compactQuery);
    const on = () => setCompact(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const touch = touchDevice || compact;
  const serverPython = useStore((s) => s.serverPython);
  const permission = useStore((s) => s.permission);
  const selection = useStore((s) => s.selection);
  const selectedChart = useStore((s) => s.selectedChart);
  const pendingCount = useStore((s) => s.proposals.reduce((n, p) => n + (p.status === 'pending' ? 1 : 0), 0));
  const attention = useStore((s) => s.attention);
  const selKind = useStore((s) => {
    const sel = s.selection;
    const c = sel && s.cells.get(sel.table)?.get(sel.ar * 65536 + sel.ac);
    return c && isCodeKind(c.k) ? c.k : null;
  });
  const wrapOn = useStore((s) => {
    const sel = s.selection;
    return !!sel && !!s.cells.get(sel.table)?.get(sel.ar * 65536 + sel.ac)?.f?.wrap;
  });
  const merged = useStore((s) => {
    const sel = s.selection;
    return !!sel && !!s.tables.get(sel.table)?.merges?.some((m) => m.r0 <= sel.r1 && sel.r0 <= m.r1 && m.c0 <= sel.c1 && sel.c0 <= m.c1);
  });
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(fileName);
  const [recent, setRecent] = useState<FileInfo[]>([]);
  const readOnly = me.role === 'viewer' || permission === 'view' || permission === 'sign' || permission === 'none';

  // recent documents for the document menu (a cheap list; errors mean no server, which is fine)
  useEffect(() => {
    let live = true;
    api.files
      .list()
      .then((fs) => live && setRecent([...fs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 6)))
      .catch(() => live && setRecent([]));
    return () => {
      live = false;
    };
  }, [fileId, savedAt]);

  const toggle = (p: Panel) => useStore.setState({ panel: panel === p ? 'none' : p });
  const btn = (p: Panel, label: string, title: string, extra?: ReactNode, cls = '') => (
    <button className={`${cls} ${panel === p ? 'active' : ''}`} onClick={() => toggle(p)} title={title}>
      {label}
      {extra}
    </button>
  );

  const docItems: MenuEntry[] = [
    { label: 'Rename', title: 'Rename this document', onClick: () => (setNameDraft(fileName), setRenaming(true)), disabled: readOnly && !!fileId },
    { label: 'New document', title: 'Start an empty document (the current one stays on the server if it was saved)', onClick: () => void newFile() },
    { label: 'Add a file (CSV, Excel, XML, JSON)…', title: 'Profiled first — columns, period, how it relates to what is here — then placed as you decide in Ask; a Gridwright JSON file replaces the document', onClick: () => pickAndImport() },
    { label: 'Import a workbook with its formulas…', title: 'Every sheet becomes a table as it is, formulas kept; nothing profiled', onClick: () => pickAndImport({ formulas: true }) },
    { label: 'Finance templates…', title: 'Reference workbooks and templates', onClick: () => useStore.setState({ panel: 'files', filesView: 'templates' }) },
    'sep',
    { head: recent.length ? 'Open recent' : 'Documents' },
    ...recent.map((f): MenuEntry => ({ label: f.name, hint: `${f.folder ? f.folder + ' · ' : ''}${new Date(f.updatedAt).toLocaleString()}`, onClick: () => void openFile(f.id), active: f.id === fileId })),
    { label: 'All documents…', title: 'Open, folders, delete', onClick: () => useStore.setState({ panel: 'files', filesView: 'documents' }) },
    'sep',
    { label: 'Download .xlsx', title: 'Every table becomes a sheet; formulas, formats and column widths are kept', onClick: () => void exportWorkbookXlsx() },
    { label: 'Download JSON', title: 'The document as Gridwright JSON', onClick: () => downloadJson() },
    { label: 'Print / PDF', title: 'Print or save as PDF: tables and charts', onClick: () => openPrintView() },
  ];
  const addItems: MenuEntry[] = [
    { label: 'Table', title: 'Add a new table to the canvas', onClick: () => addTable() },
    { label: 'Chart from selection', title: 'Insert a chart built from the selection (exhibit style)', onClick: () => void insertChart(), disabled: !selection },
    'sep',
    { label: 'Add a file…', title: 'CSV, Excel, XML or JSON — profiled, then placed as you decide in Ask', onClick: () => pickAndImport() },
  ];
  // code cells: Python is one click (the common case); JavaScript, SQL and the panel sit under its caret
  const codeItems: MenuEntry[] = [
    { head: 'Turn the selected cell into' },
    { label: 'Python cell', title: 'Turn the selected cell into a Python cell', hint: 'runs on the server or in the browser', onClick: () => makeCodeCell('python'), disabled: !selection },
    { label: 'Agent cell', title: 'A Python cell with the companion: LangChain, DeepAgents, LangGraph, the model and the document\'s context — sandboxed, proposes only', hint: serverPython?.agent ? 'LangChain · DeepAgents · LangGraph, sandboxed' : 'needs the stack on the server', onClick: () => makeAgentCell(), disabled: !selection || !serverPython?.agent },
    { label: 'JavaScript cell', title: 'Turn the selected cell into a JavaScript cell', onClick: () => makeCodeCell('javascript'), disabled: !selection },
    { label: 'SQL cell', title: 'Turn the selected cell into a SQL cell (query result spills from it)', hint: 'needs a database connection', onClick: () => makeCodeCell('sql'), disabled: !selection },
    'sep',
    { label: 'Code panel', title: 'Code editor for Python / JavaScript / SQL cells: edit, run, runtime, GPU', onClick: () => toggle('code'), active: panel === 'code' },
  ];
  const moreItems: MenuEntry[] = [
    ...(touch
      ? ([
          { label: 'Undo', onClick: () => book.undo(), disabled: !canUndo },
          { label: 'Redo', onClick: () => book.redo(), disabled: !canRedo },
          'sep',
          { label: 'Share', title: 'Who can open this document, and copies to send', onClick: () => toggle('share'), active: panel === 'share' },
          ...(readOnly
            ? []
            : ([
                'sep',
                { label: selKind ? `${KIND_LABEL[selKind]} cell` : 'Python cell', title: selKind ? `Open the code of the selected ${KIND_LABEL[selKind]} cell` : 'Turn the selected cell into a Python cell', hint: selection ? undefined : 'select a cell first', onClick: () => makeCodeCell(selKind ?? 'python'), disabled: !selection },
                { label: 'Agent cell', title: 'A Python cell with the companion: LangChain, DeepAgents, LangGraph, the model and the context — sandboxed, proposes only', hint: !serverPython?.agent ? 'needs the stack on the server' : selection ? 'LangChain · DeepAgents · LangGraph' : 'select a cell first', onClick: () => makeAgentCell(), disabled: !selection || !serverPython?.agent },
                { label: 'Code panel', title: 'Code editor for Python / JavaScript / SQL cells: edit, run, runtime', onClick: () => toggle('code'), active: panel === 'code' },
              ] as MenuEntry[])),
        ] as MenuEntry[])
      : []),
    { label: 'Tables and charts', title: 'Jump to a table or chart; fit the view', onClick: () => toggle('navigate'), active: panel === 'navigate' },
    { label: 'Table', title: 'Table inspector: name, size, header row, pivot', onClick: () => toggle('table'), active: panel === 'table' },
    { label: 'Rules', title: 'Conditional formatting, validation, names', onClick: () => toggle('format'), active: panel === 'format' },
    { label: 'Chart', title: 'Charts as exhibits: title, series, highlight, benchmark, export', onClick: () => toggle('chart'), active: panel === 'chart' },
    { label: 'Database', title: 'Database connections and ad-hoc queries', onClick: () => toggle('sql'), active: panel === 'sql' },
    'sep',
    { label: 'History', title: 'Audit trail: every change, by whom, restore versions', onClick: () => toggle('history'), active: panel === 'history' },
    { label: 'Files', title: 'Open, import, templates, downloads', onClick: () => useStore.setState({ panel: panel === 'files' ? 'none' : 'files', filesView: 'documents' }), active: panel === 'files' },
    { label: 'Print / PDF', title: 'Print or save as PDF: tables and charts', onClick: () => openPrintView() },
    'sep',
    { label: 'Settings', title: 'Settings', onClick: () => toggle('settings'), active: panel === 'settings' },
  ];

  // accounts mode: the client this tab works in, the others, and the way to people and one's account
  const openAdmin = (v: 'members' | 'account' | 'clients') => useStore.setState({ panel: 'admin', adminView: v });
  const clientItems: MenuEntry[] = me.auth === 'accounts'
    ? [
        { head: `${me.name || me.login} · ${me.login}` },
        ...(me.tenants ?? []).map((t): MenuEntry => ({ label: t.name, hint: `${t.role}${t.status === 'suspended' ? ' · suspended' : ''}`, active: t.id === me.tenant?.id, disabled: t.status === 'suspended' && !me.platformAdmin, title: t.id === me.tenant?.id ? 'the client this tab works in' : `Work in ${t.name} in this tab (each tab can be in its own client)`, onClick: () => t.id !== me.tenant?.id && switchTenant(t) })),
        'sep',
        { label: me.role === 'admin' ? 'Members & access…' : 'Members…', title: 'Who is in this client and with which role', onClick: () => openAdmin('members') },
        ...(me.platformAdmin ? [{ label: 'Platform console…', title: 'Every client and person on this server', onClick: () => openAdmin('clients') } as MenuEntry] : []),
        { label: 'My account…', title: 'Name, password, API tokens', onClick: () => openAdmin('account') },
        'sep',
        { label: 'Sign out', onClick: () => void accounts.logout().finally(() => (setCurrentTenant(''), location.assign(location.origin + location.pathname))) },
      ]
    : [];

  const saveState = saving ? 'saving' : !fileId ? 'new' : dirty ? 'needed' : 'done';
  const saveLabel = saving ? 'Saving…' : saveState === 'done' ? 'Saved' : 'Save';
  const saveTitle =
    saveState === 'saving'
      ? 'Saving to the server'
      : saveState === 'new'
        ? 'Save (Ctrl+S) — not on the server yet; saving creates the document and turns on autosave'
        : saveState === 'needed'
          ? 'Save (Ctrl+S) — unsaved changes; the server autosaves a few seconds after each change'
          : `Saved to the server${savedAt ? ' at ' + timeOf(savedAt) : ''} — every change autosaves`;

  return (
    <header className="topbar">
      <div className="brand" title="Gridwright">
        <span className="logo">▦</span>
      </div>
      {renaming ? (
        <input
          className="filename-input"
          autoFocus
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            setRenaming(false);
            if (nameDraft.trim() && nameDraft.trim() !== fileName) {
              book.getBook().set_name(nameDraft.trim());
              useStore.setState({ fileName: nameDraft.trim(), dirty: true });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setRenaming(false);
            e.stopPropagation();
          }}
        />
      ) : (
        <Menu label={<span className="filename">{fileName}</span>} title="This document: rename, new, open, import, templates, downloads" className="doc-menu" items={docItems} testId="doc" />
      )}
      <button className={`save-btn ${saveState}`} disabled={saving} onClick={() => void saveCurrentFile()} title={saveTitle}>
        {saveLabel}
        {saveState === 'needed' && <span className="dot" aria-hidden="true" />}
      </button>
      <button className="tb-icon phone-hide" disabled={!canUndo} onClick={() => book.undo()} title="Undo (Ctrl+Z)">
        ↶
      </button>
      <button className="tb-icon phone-hide" disabled={!canRedo} onClick={() => book.redo()} title="Redo (Ctrl+Y)">
        ↷
      </button>
      <span className="sep phone-hide" />
      {!readOnly && <Menu label="Add" title="Tables, charts, import" items={addItems} testId="add" className="phone-hide" />}
      {!readOnly && (
        <Menu
          className="phone-hide"
          main={{
            label: selKind ? KIND_LABEL[selKind] : 'Python',
            title: selKind ? `Open the code of the selected ${KIND_LABEL[selKind]} cell` : 'Turn the selected cell into a Python cell',
            onClick: () => makeCodeCell(selKind ?? 'python'),
            disabled: !selection,
            active: panel === 'code',
          }}
          title="JavaScript and SQL cells, the Code panel"
          items={codeItems}
          testId="code"
        />
      )}
      {btn('ai', 'Ask', attention ? `${attention} issue${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} attention — the companion's brief is in Ask` : 'Ask the assistant; the companion keeps the context and the brief here', attention ? <span className="count">{attention}</span> : null)}
      {btn('review', 'Review', 'Proposals awaiting review, checks, code-cell evidence, sign-offs', pendingCount ? <span className="count">{pendingCount}</span> : null)}
      {btn('share', 'Share', 'Who can open this document, and copies to send', undefined, 'phone-hide')}
      <span className="grow" />
      {(me.role === 'viewer' || permission === 'view') && <span className="pill">read-only</span>}
      {permission === 'sign' && me.role !== 'viewer' && <span className="pill">sign-off only</span>}
      {selection && !readOnly && (
        <Menu label="Format" title="Formatting for the selected cells" className="format-menu phone-hide" testId="format">
          <div className="fmt-row">
            <button onClick={() => toggleBold()} title="Bold (Ctrl+B)">
              <b>B</b>
            </button>
            <button onClick={() => applyFormat({ align: 'left' })} title="Align left">
              ⇤
            </button>
            <button onClick={() => applyFormat({ align: 'center' })} title="Align centre">
              ↔
            </button>
            <button onClick={() => applyFormat({ align: 'right' })} title="Align right">
              ⇥
            </button>
            <button className={wrapOn ? 'active' : ''} onClick={() => applyFormat({ wrap: !wrapOn })} title="Wrap text in the selected cells">
              ↵
            </button>
            <button
              className={merged ? 'active' : ''}
              disabled={selection.r0 === selection.r1 && selection.c0 === selection.c1 && !merged}
              onClick={() => {
                const sel = selection;
                if (merged) book.apply({ type: 'unmerge_cells', table: sel.table, r0: sel.r0, c0: sel.c0, r1: sel.r1, c1: sel.c1 });
                else book.apply({ type: 'merge_cells', table: sel.table, r0: sel.r0, c0: sel.c0, r1: sel.r1, c1: sel.c1 });
              }}
              title={merged ? 'Unmerge cells' : 'Merge the selected cells (the top-left value is kept)'}
            >
              ⊞
            </button>
          </div>
          <label className="fmt-row">
            <span className="muted small">Number</span>
            <select className="fmt-select grow" defaultValue="" onChange={(e) => applyFormat({ number_format: e.target.value })} title="Number format">
              {NUMBER_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <div className="fmt-row">
            <span className="muted small">Fill</span>
            <div className="swatches" title="Fill colour">
              {FILLS.map((c) => (
                <button key={c || 'none'} className="swatch" style={{ background: c || 'white' }} onClick={() => applyFormat({ fill: c })}>
                  {c ? '' : '×'}
                </button>
              ))}
            </div>
          </div>
          <div className="fmt-row">
            <span className="muted small">Text</span>
            <div className="swatches" title="Text colour">
              {COLORS.map((c) => (
                <button key={c || 'none'} className="swatch text" style={{ color: c || '#111827' }} onClick={() => applyFormat({ color: c })}>
                  A
                </button>
              ))}
            </div>
          </div>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => autoFitColumns(selection.table, selection.c0, selection.c1)} title="Widen the selected columns to their widest value, so no amount shows as ####">
            <span>Fit column{selection.c1 > selection.c0 ? 's' : ''} to values</span>
            <span className="muted small">also: double-click a column edge</span>
          </button>
          <button className="menu-item" onClick={() => useStore.setState({ panel: 'format' })} title="Conditional formatting, validation, names">
            <span>Rules…</span>
            <span className="muted small">conditional formats, validation, names</span>
          </button>
          <button className="menu-item" onClick={() => useStore.setState({ panel: 'table' })} title="Table inspector: name, size, header row, pivot">
            <span>Table…</span>
            <span className="muted small">name, size, header row, pivot</span>
          </button>
        </Menu>
      )}
      {selectedChart !== null && btn('chart', 'Chart', 'The selected chart: title, series, highlight, benchmark, export')}
      {me.auth === 'accounts' && <Menu label={<span className="client-chip">{me.tenant?.name ?? 'No client'}</span>} title={`Client: ${me.tenant?.name ?? '—'} (your role: ${me.role}) — switch client, members, your account`} className="client-menu" items={clientItems} testId="client" active={panel === 'admin'} />}
      <Menu label="More" title="Everything else: navigation, tables, rules, charts, database, history, files, print, settings" items={moreItems} testId="more" active={['navigate', 'table', 'format', 'sql', 'history', 'files', 'settings'].includes(panel)} />
    </header>
  );
}
