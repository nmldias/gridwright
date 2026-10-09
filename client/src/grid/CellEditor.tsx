import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as book from '../engine/book';
import { useStore } from '../state/store';
import { cancelEdit, commitEdit } from './actions';
import { layoutOf } from './geometry';
import { displayValue } from './format';
import type { GridRenderer } from './renderer';
import { FONT, FONT_SIZE } from './renderer';

export function CellEditor({ renderer, tick }: { renderer: GridRenderer; tick: number }) {
  const editing = useStore((s) => s.editing);
  const editorText = useStore((s) => s.editorText);
  const tables = useStore((s) => s.tables);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [refocus, setRefocus] = useState(0);

  useLayoutEffect(() => {
    if (!editing || editing.source === 'bar') return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (editing.replace) el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
  }, [editing, refocus]);

  useEffect(() => {
    if (!editing) {
      setPreview(null);
      return;
    }
    if (editorText.startsWith('=') && editorText.length > 1) {
      try {
        const v = book.preview(editing.table, editorText);
        setPreview(displayValue(v));
      } catch {
        setPreview(null);
      }
    } else setPreview(null);
  }, [editorText, editing]);

  // entries of a list validation covering the cell (dropdown)
  const entries = useMemo(() => {
    if (!editing) return [] as string[];
    const meta = tables.get(editing.table);
    if (!meta || !meta.validations.length) return [] as string[];
    try {
      return book.listEntries(editing.table, editing.r, editing.c);
    } catch {
      return [] as string[];
    }
  }, [editing, tables]);

  if (!editing) return null;
  const meta = tables.get(editing.table);
  if (!meta) return null;
  const L = layoutOf(meta);
  const z = renderer.zoom;
  const p = renderer.worldToScreen(meta.x + L.colX[editing.c], meta.y + L.rowY[editing.r]);
  const w = (L.colX[editing.c + 1] - L.colX[editing.c]) * z;
  const h = (L.rowY[editing.r + 1] - L.rowY[editing.r]) * z;
  void tick;

  const commit = (move: { dr: number; dc: number } | null) => {
    if (!commitEdit(editorText, move)) setRefocus((n) => n + 1);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.altKey) {
      e.preventDefault();
      commit({ dr: e.shiftKey ? -1 : 1, dc: 0 });
    } else if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      useStore.setState({ editorText: editorText + '\n' });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commit({ dr: 0, dc: e.shiftKey ? -1 : 1 });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
    e.stopPropagation();
  };

  const minWidth = Math.max(w, 60);
  const filtered = entries.filter((x) => !editorText || x.toLowerCase().includes(editorText.toLowerCase())).slice(0, 12);
  return (
    <div className="cell-editor-wrap" style={{ left: p.x, top: p.y }}>
      <textarea
        ref={ref}
        className="cell-editor"
        value={editorText}
        rows={1}
        spellCheck={false}
        style={{
          minWidth,
          width: Math.max(minWidth, editorText.length * FONT_SIZE * 0.6 * z + 16),
          height: Math.max(h, 20),
          fontFamily: FONT,
          fontSize: FONT_SIZE * z,
          lineHeight: `${Math.max(h, 20)}px`,
        }}
        onChange={(e) => useStore.setState({ editorText: e.target.value })}
        onKeyDown={onKey}
        onBlur={() => {
          // commit on blur unless the editor is being torn down by a commit already
          const st = useStore.getState();
          if (st.editing && !commitEdit(st.editorText, null)) setRefocus((n) => n + 1);
        }}
      />
      {preview !== null && <div className="formula-preview">= {preview}</div>}
      {filtered.length > 0 && (
        <div className="list-dropdown" onPointerDown={(e) => e.preventDefault()}>
          {filtered.map((x) => (
            <button
              key={x}
              className="list-item"
              onClick={() => {
                useStore.setState({ editorText: x });
                window.setTimeout(() => commitEdit(x, { dr: 1, dc: 0 }), 0);
              }}
            >
              {x}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
