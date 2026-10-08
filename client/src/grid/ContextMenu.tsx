import { useEffect, useState } from 'react';
import * as book from '../engine/book';
import { getState, useStore } from '../state/store';
import { clearSelection, copySelection, deleteSelectedTable, makeCodeCell, pasteFromClipboard, selectionToTsv, sortTableByColumn } from './actions';
import { colToLetters } from '../engine/types';
import type { Hit } from './geometry';

interface MenuState {
  x: number;
  y: number;
  hit: Hit;
}

export function exportTableCsv(tableId: number) {
  const st = getState();
  const meta = st.tables.get(tableId);
  if (!meta) return;
  const { tsv } = selectionToTsv({ table: tableId, r0: 0, c0: 0, r1: meta.rows - 1, c1: meta.cols - 1, ar: 0, ac: 0 });
  const csv = tsv
    .split('\n')
    .map((line) =>
      line
        .split('\t')
        .map((f) => (/[",\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f))
        .join(','),
    )
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${meta.name}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function ContextMenu({ host }: { host: HTMLElement | null }) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    if (!host) return;
    const onMenu = (e: Event) => setMenu((e as CustomEvent).detail as MenuState);
    const close = () => setMenu(null);
    host.addEventListener('gw-contextmenu', onMenu);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('wheel', close);
    return () => {
      host.removeEventListener('gw-contextmenu', onMenu);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('wheel', close);
    };
  }, [host]);

  if (!menu) return null;
  const sel = getState().selection;
  const tableId = menu.hit.kind === 'none' ? null : (menu.hit as { table: number }).table;
  const rows = sel ? sel.r1 - sel.r0 + 1 : 1;
  const cols = sel ? sel.c1 - sel.c0 + 1 : 1;
  const item = (label: string, fn: () => void, disabled = false) => (
    <button
      className="menu-item"
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        setMenu(null);
        fn();
      }}
    >
      {label}
    </button>
  );
  const sep = <div className="menu-sep" />;
  const left = Math.min(menu.x, window.innerWidth - 230);
  const top = Math.min(menu.y, window.innerHeight - 420);
  return (
    <div className="context-menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {sel && tableId !== null && (
        <>
          {item('Cut', () => void copySelection(true))}
          {item('Copy', () => void copySelection(false))}
          {item('Paste', () => void pasteFromClipboard())}
          {item('Clear', () => clearSelection())}
          {sep}
          {item(`Insert ${rows} row${rows > 1 ? 's' : ''} above`, () => book.apply({ type: 'insert_rows', table: sel.table, at: sel.r0, count: rows }))}
          {item(`Insert ${rows} row${rows > 1 ? 's' : ''} below`, () => book.apply({ type: 'insert_rows', table: sel.table, at: sel.r1 + 1, count: rows }))}
          {item(`Delete row${rows > 1 ? 's' : ''}`, () => book.apply({ type: 'delete_rows', table: sel.table, at: sel.r0, count: rows }))}
          {item(`Insert ${cols} column${cols > 1 ? 's' : ''} left`, () => book.apply({ type: 'insert_cols', table: sel.table, at: sel.c0, count: cols }))}
          {item(`Insert ${cols} column${cols > 1 ? 's' : ''} right`, () => book.apply({ type: 'insert_cols', table: sel.table, at: sel.c1 + 1, count: cols }))}
          {item(`Delete column${cols > 1 ? 's' : ''}`, () => book.apply({ type: 'delete_cols', table: sel.table, at: sel.c0, count: cols }))}
          {sep}
          {item(`Sort ${rows > 1 ? 'selected rows' : 'table'} A→Z by column ${colToLetters(sel.ac)}`, () => sortTableByColumn(sel.table, sel.ac, true, rows > 1 ? { r0: sel.r0, r1: sel.r1 } : undefined))}
          {item(`Sort ${rows > 1 ? 'selected rows' : 'table'} Z→A by column ${colToLetters(sel.ac)}`, () => sortTableByColumn(sel.table, sel.ac, false, rows > 1 ? { r0: sel.r0, r1: sel.r1 } : undefined))}
          {sep}
          {item('Python cell', () => makeCodeCell('python'))}
          {item('JavaScript cell', () => makeCodeCell('javascript'))}
          {sep}
          {item('Table settings…', () => useStore.setState({ panel: 'table', selectedTable: sel.table }))}
          {item('Export table as CSV', () => exportTableCsv(sel.table))}
          {item('Delete table', () => {
            useStore.setState({ selectedTable: sel.table });
            deleteSelectedTable();
          })}
        </>
      )}
      {(!sel || tableId === null) && item('New table here', () => {
        const r = (window as any).__gw?.viewport?.() ?? { x: 0, y: 0, zoom: 1 };
        const rect = host?.getBoundingClientRect();
        const wx = rect ? (menu.x - rect.left - r.x) / r.zoom : 80;
        const wy = rect ? (menu.y - rect.top - r.y) / r.zoom : 80;
        const ch = book.apply({ type: 'add_table', x: Math.round(wx / 8) * 8, y: Math.round(wy / 8) * 8, rows: 10, cols: 5 });
        const id = ch.created?.[0];
        if (id) useStore.setState({ selectedTable: id, selection: { table: id, r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 } });
      })}
    </div>
  );
}
