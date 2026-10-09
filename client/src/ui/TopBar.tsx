import { useState } from 'react';
import * as book from '../engine/book';
import { addTable, applyFormat, makeCodeCell, toggleBold } from '../grid/actions';
import { NUMBER_FORMATS } from '../grid/format';
import { useStore, type Panel } from '../state/store';
import { saveCurrentFile } from './files';
import { openPrintView } from './print';
import { insertChart } from './review';

const FILLS = ['', '#fef3c7', '#dcfce7', '#dbeafe', '#fce7f3', '#f3f4f6', '#fee2e2'];
const COLORS = ['', '#111827', '#b91c1c', '#1d4ed8', '#047857', '#6b7280', '#7c3aed'];

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

  const toggle = (p: Panel) => useStore.setState({ panel: panel === p ? 'none' : p });
  const btn = (p: Panel, label: string, title: string) => (
    <button className={panel === p ? 'active' : ''} onClick={() => toggle(p)} title={title}>
      {label}
    </button>
  );

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
      <span className="sep" />
      <button disabled={!canUndo} onClick={() => book.undo()} title="Undo (Ctrl+Z)">
        ↶
      </button>
      <button disabled={!canRedo} onClick={() => book.redo()} title="Redo (Ctrl+Y)">
        ↷
      </button>
      <span className="sep" />
      <button onClick={() => addTable()} title="Add a new table to the canvas">
        + Table
      </button>
      <button onClick={() => makeCodeCell('python')} title="Turn the selected cell into a Python cell">
        Py
      </button>
      <button onClick={() => makeCodeCell('javascript')} title="Turn the selected cell into a JavaScript cell">
        JS
      </button>
      <button onClick={() => makeCodeCell('sql')} title="Turn the selected cell into a SQL cell (query result spills from it)">
        SQL
      </button>
      <button onClick={() => insertChart()} title="Insert a chart built from the selection (exhibit style)">
        + Chart
      </button>
      <span className="sep" />
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
        disabled={!selection || (selection.r0 === selection.r1 && selection.c0 === selection.c1 && !merged)}
        onClick={() => {
          const sel = selection!;
          if (merged) book.apply({ type: 'unmerge_cells', table: sel.table, r0: sel.r0, c0: sel.c0, r1: sel.r1, c1: sel.c1 });
          else book.apply({ type: 'merge_cells', table: sel.table, r0: sel.r0, c0: sel.c0, r1: sel.r1, c1: sel.c1 });
        }}
        title={merged ? 'Unmerge cells' : 'Merge the selected cells (the top-left value is kept)'}
      >
        ⊞
      </button>
      <select className="fmt-select" defaultValue="" onChange={(e) => applyFormat({ number_format: e.target.value })} title="Number format">
        {NUMBER_FORMATS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <div className="swatches" title="Fill colour">
        {FILLS.map((c) => (
          <button key={c || 'none'} className="swatch" style={{ background: c || 'white' }} onClick={() => applyFormat({ fill: c })}>
            {c ? '' : '×'}
          </button>
        ))}
      </div>
      <div className="swatches" title="Text colour">
        {COLORS.map((c) => (
          <button key={c || 'none'} className="swatch text" style={{ color: c || '#111827' }} onClick={() => applyFormat({ color: c })}>
            A
          </button>
        ))}
      </div>
      <span className="grow" />
      {(me.role === 'viewer' || permission === 'view') && <span className="pill">read-only</span>}
      {permission === 'sign' && me.role !== 'viewer' && <span className="pill">sign-off only</span>}
      {btn('table', 'Table', 'Table inspector: name, size, header row, pivot')}
      {btn('format', 'Rules', 'Conditional formatting, validation, names')}
      {btn('chart', 'Chart', 'Charts as exhibits: title, series, highlight, benchmark, export')}
      {btn('review', 'Review', 'Sign-offs, checks and precedent/dependent tracing')}
      {btn('code', 'Code', 'Code editor for Python / JavaScript / SQL cells')}
      {btn('sql', 'DB', 'Database connections and ad-hoc queries')}
      {btn('ai', 'AI', 'AI assistant')}
      {btn('history', 'History', 'Audit trail: every change, by whom, restore versions')}
      {btn('files', 'Files', 'Open, save, import, export, sharing')}
      <button onClick={() => openPrintView()} title="Print or save as PDF: tables and charts">
        Print
      </button>
      {btn('settings', '⚙', 'Settings')}
      {touch && (
        <button className={panel === 'none' ? '' : 'active'} onClick={() => useStore.setState({ panel: 'none' })} title="Close panel">
          ✕
        </button>
      )}
    </div>
  );
}
