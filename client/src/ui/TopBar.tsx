import { useState } from 'react';
import * as book from '../engine/book';
import { addTable, applyFormat, makeCodeCell, toggleBold } from '../grid/actions';
import { useStore, type Panel } from '../state/store';
import { saveCurrentFile } from './files';

const NUMBER_FORMATS: { label: string; value: string }[] = [
  { label: 'General', value: '' },
  { label: 'Number 0.00', value: '0.00' },
  { label: 'Integer', value: '0' },
  { label: 'Thousands 1,000', value: '#,##0' },
  { label: 'Thousands 1,000.00', value: '#,##0.00' },
  { label: 'Percent 0%', value: '0%' },
  { label: 'Percent 0.0%', value: '0.0%' },
  { label: 'Currency EUR', value: 'currency:EUR' },
  { label: 'Currency USD', value: 'currency:USD' },
  { label: 'Currency AOA', value: 'currency:AOA' },
  { label: 'Date yyyy-mm-dd', value: 'yyyy-mm-dd' },
  { label: 'Date dd/mm/yyyy', value: 'dd/mm/yyyy' },
];

const FILLS = ['', '#fef3c7', '#dcfce7', '#dbeafe', '#fce7f3', '#f3f4f6', '#fee2e2'];
const COLORS = ['', '#111827', '#b91c1c', '#1d4ed8', '#047857', '#6b7280', '#7c3aed'];

export function TopBar() {
  const fileName = useStore((s) => s.fileName);
  const dirty = useStore((s) => s.dirty);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const panel = useStore((s) => s.panel);
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
      {btn('table', 'Table', 'Table inspector: name, size, header rows')}
      {btn('code', 'Code', 'Code editor for Python / JavaScript cells')}
      {btn('sql', 'SQL', 'Database connections and queries')}
      {btn('ai', 'AI', 'AI assistant')}
      {btn('files', 'Files', 'Open, save, import')}
      {btn('settings', '⚙', 'Settings')}
    </div>
  );
}
