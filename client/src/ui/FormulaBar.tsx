import { useEffect, useRef } from 'react';
import * as book from '../engine/book';
import { a1, isCodeKind } from '../engine/types';
import { openCodeCell, selectCell } from '../grid/actions';
import { cellAt, useStore } from '../state/store';

export function FormulaBar() {
  const selection = useStore((s) => s.selection);
  const tables = useStore((s) => s.tables);
  const editing = useStore((s) => s.editing);
  const editorText = useStore((s) => s.editorText);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const ref = useRef<HTMLInputElement>(null);
  void cellsVersion;

  const meta = selection ? tables.get(selection.table) : undefined;
  const cell = selection ? cellAt(selection.table, selection.ar, selection.ac) : undefined;
  const isCode = cell && isCodeKind(cell.k);
  const label = meta && selection ? `${meta.name}::${a1(selection.ar, selection.ac)}` : '';
  const shown = editing ? editorText : (cell?.s ? '' : (cell?.i ?? ''));

  useEffect(() => {
    if (!editing && ref.current && document.activeElement === ref.current) ref.current.blur();
  }, [editing]);

  const commit = () => {
    if (!selection || !ref.current) return;
    const text = ref.current.value;
    const prev = cell?.i ?? '';
    if (text !== prev && !cell?.s) book.apply({ type: 'set_cell', table: selection.table, row: selection.ar, col: selection.ac, input: text });
    useStore.setState({ editing: null, editorText: text });
    selectCell(selection.table, selection.ar + 1, selection.ac);
  };

  return (
    <div className="formula-bar">
      <div className="name-box" title="Active cell (table::reference)">
        {label}
      </div>
      <div className="fx">fx</div>
      {isCode ? (
        <button className="code-link" onClick={() => selection && openCodeCell(selection.table, selection.ar, selection.ac)}>
          {cell!.k === 'python' ? 'Python' : cell!.k === 'sql' ? 'SQL' : 'JavaScript'} cell — open in code editor
        </button>
      ) : (
        <input
          ref={ref}
          className="formula-input"
          value={shown}
          placeholder={cell?.s ? 'spilled output (read-only)' : ''}
          readOnly={!!cell?.s}
          spellCheck={false}
          onFocus={() => {
            if (selection && !editing && !cell?.s) useStore.setState({ editing: { table: selection.table, r: selection.ar, c: selection.ac, initial: cell?.i ?? '', replace: false, source: 'bar' }, editorText: cell?.i ?? '' });
          }}
          onChange={(e) => useStore.setState({ editorText: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              useStore.setState({ editing: null, editorText: cell?.i ?? '' });
              ref.current?.blur();
            }
            e.stopPropagation();
          }}
        />
      )}
    </div>
  );
}
