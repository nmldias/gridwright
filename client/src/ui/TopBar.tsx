import { useState, type ReactNode } from 'react';
import * as book from '../engine/book';
import { isCodeKind } from '../engine/types';
import { addTable, applyFormat, makeCodeCell, toggleBold } from '../grid/actions';
import { NUMBER_FORMATS } from '../grid/format';
import { useStore, type Panel } from '../state/store';
import { saveCurrentFile } from './files';
import { Menu, type MenuEntry } from './Menu';
import { openPrintView } from './print';
import { insertChart } from './review';

const FILLS = ['', '#fef3c7', '#dcfce7', '#dbeafe', '#fce7f3', '#f3f4f6', '#fee2e2'];
const COLORS = ['', '#111827', '#b91c1c', '#1d4ed8', '#047857', '#6b7280', '#7c3aed'];

/**
 * The primary bar: document name · Add · Ask · Review · Share. Everything else is contextual —
 * Format appears with a selection, Chart with a selected chart, Code with a code cell — or lives
 * under More, so that the screen a reviewer sees carries only what the task needs.
 */
export function TopBar() {
  const fileName = useStore((s) => s.fileName);
  const dirty = useStore((s) => s.dirty);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const panel = useStore((s) => s.panel);
  const me = useStore((s) => s.me);
  const touch = useStore((s) => s.touch);
  const permission = useStore((s) => s.permission);
  const selection = useStore((s) => s.selection);
  const selectedChart = useStore((s) => s.selectedChart);
  const pendingCount = useStore((s) => s.proposals.reduce((n, p) => n + (p.status === 'pending' ? 1 : 0), 0));
  const onCodeCell = useStore((s) => {
    const sel = s.selection;
    const c = sel && s.cells.get(sel.table)?.get(sel.ar * 65536 + sel.ac);
    return !!c && isCodeKind(c.k);
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
  const readOnly = me.role === 'viewer' || permission === 'view' || permission === 'sign' || permission === 'none';

  const toggle = (p: Panel) => useStore.setState({ panel: panel === p ? 'none' : p });
  const btn = (p: Panel, label: string, title: string, extra?: ReactNode) => (
    <button className={panel === p ? 'active' : ''} onClick={() => toggle(p)} title={title}>
      {label}
      {extra}
    </button>
  );

  const addItems: MenuEntry[] = [
    { label: 'Table', title: 'Add a new table to the canvas', onClick: () => addTable(), disabled: readOnly },
    { label: 'Chart from selection', title: 'Insert a chart built from the selection (exhibit style)', onClick: () => void insertChart(), disabled: readOnly || !selection },
    'sep',
    { head: 'Turn the selected cell into' },
    { label: 'Python cell', title: 'Turn the selected cell into a Python cell', hint: 'runs on the server or in the browser', onClick: () => makeCodeCell('python'), disabled: readOnly || !selection },
    { label: 'JavaScript cell', title: 'Turn the selected cell into a JavaScript cell', onClick: () => makeCodeCell('javascript'), disabled: readOnly || !selection },
    { label: 'SQL cell', title: 'Turn the selected cell into a SQL cell (query result spills from it)', hint: 'needs a database connection', onClick: () => makeCodeCell('sql'), disabled: readOnly || !selection },
  ];
  const moreItems: MenuEntry[] = [
    { label: 'Table', title: 'Table inspector: name, size, header row, pivot', onClick: () => toggle('table'), active: panel === 'table' },
    { label: 'Rules', title: 'Conditional formatting, validation, names', onClick: () => toggle('format'), active: panel === 'format' },
    { label: 'Chart', title: 'Charts as exhibits: title, series, highlight, benchmark, export', onClick: () => toggle('chart'), active: panel === 'chart' },
    { label: 'Code', title: 'Code editor for Python / JavaScript / SQL cells', onClick: () => toggle('code'), active: panel === 'code' },
    { label: 'Database', title: 'Database connections and ad-hoc queries', onClick: () => toggle('sql'), active: panel === 'sql' },
    'sep',
    { label: 'History', title: 'Audit trail: every change, by whom, restore versions', onClick: () => toggle('history'), active: panel === 'history' },
    { label: 'Files', title: 'Open, import, templates, downloads', onClick: () => toggle('files'), active: panel === 'files' },
    { label: 'Print / PDF', title: 'Print or save as PDF: tables and charts', onClick: () => openPrintView() },
    'sep',
    { label: 'Settings', title: 'Settings', onClick: () => toggle('settings'), active: panel === 'settings' },
  ];

  return (
    <div className="topbar">
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
            if (nameDraft.trim()) {
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
        <button
          className="filename"
          title="Rename"
          onClick={() => {
            setNameDraft(fileName);
            setRenaming(true);
          }}
        >
          {fileName}
          {dirty ? ' •' : ''}
        </button>
      )}
      <button onClick={() => void saveCurrentFile()} title="Save (Ctrl+S)">
        Save
      </button>
      <button className="tb-icon" disabled={!canUndo} onClick={() => book.undo()} title="Undo (Ctrl+Z)">
        ↶
      </button>
      <button className="tb-icon" disabled={!canRedo} onClick={() => book.redo()} title="Redo (Ctrl+Y)">
        ↷
      </button>
      <span className="sep" />
      <Menu label="Add" title="Tables, charts and code cells" items={addItems} testId="add" />
      {btn('ai', 'Ask', 'Ask the AI assistant about this document')}
      {btn('review', 'Review', 'Changes awaiting approval, checks, code-cell evidence, sign-offs', pendingCount ? <span className="count">{pendingCount}</span> : null)}
      {btn('share', 'Share', 'Who can open this document, and copies to send')}
      <span className="grow" />
      {(me.role === 'viewer' || permission === 'view') && <span className="pill">read-only</span>}
      {permission === 'sign' && me.role !== 'viewer' && <span className="pill">sign-off only</span>}
      {selection && !readOnly && (
        <Menu label="Format" title="Formatting for the selected cells" className="format-menu" testId="format">
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
      {onCodeCell && btn('code', 'Code', 'The selected code cell: edit, run, runtime')}
      <Menu label="More" title="Everything else: tables, rules, charts, code, database, history, files, print, settings" items={moreItems} testId="more" active={['table', 'format', 'sql', 'history', 'files', 'settings'].includes(panel)} />
      {touch && panel !== 'none' && (
        <button className="tb-icon" onClick={() => useStore.setState({ panel: 'none' })} title="Close panel">
          ✕
        </button>
      )}
    </div>
  );
}
