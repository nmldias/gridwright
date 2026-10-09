import { useEffect, useState } from 'react';
import { api, type HistoryEntry } from '../api/client';
import * as book from '../engine/book';
import { a1, colToLetters, type Op } from '../engine/types';
import { getState, setStatus, useStore } from '../state/store';

function describe(e: HistoryEntry, tableName: (id: number) => string): string {
  if (!e.op) return e.note ?? (e.checkpoint ? 'snapshot' : '');
  const op = e.op as unknown as Op & Record<string, any>;
  const t = () => tableName(Number(op.table));
  switch (op.type) {
    case 'set_cell': {
      const v = String(op.input ?? '');
      return `${t()}::${a1(op.row, op.col)} = ${v.length > 60 ? v.slice(0, 57) + '…' : v || '(cleared)'}${op.kind && op.kind !== 'value' && op.kind !== 'formula' ? ` [${op.kind}]` : ''}`;
    }
    case 'set_cells': {
      const rows = op.values?.length ?? 0;
      const cols = Math.max(0, ...(op.values ?? []).map((r: string[]) => r.length));
      return `${t()}::${a1(op.row, op.col)} ← ${rows}×${cols} block`;
    }
    case 'clear_range':
      return `${t()}: cleared ${a1(op.r0, op.c0)}:${a1(op.r1, op.c1)}`;
    case 'set_format':
      return `${t()}: format ${a1(op.r0, op.c0)}:${a1(op.r1, op.c1)} ${JSON.stringify(op.format)}`;
    case 'resize_table':
      return `${t()}: resized to ${op.rows}×${op.cols}`;
    case 'move_table':
      return `${t()}: moved`;
    case 'rename_table':
      return `table renamed to “${op.name}”`;
    case 'set_col_width':
      return `${t()}: column ${colToLetters(op.col)} width ${op.width}`;
    case 'set_row_height':
      return `${t()}: row ${op.row + 1} height ${op.height}`;
    case 'set_header_rows':
      return `${t()}: header rows ${op.header_rows}`;
    case 'insert_rows':
      return `${t()}: inserted ${op.count} row(s) at ${op.at + 1}`;
    case 'delete_rows':
      return `${t()}: deleted ${op.count} row(s) at ${op.at + 1}`;
    case 'insert_cols':
      return `${t()}: inserted ${op.count} column(s) at ${colToLetters(op.at)}`;
    case 'delete_cols':
      return `${t()}: deleted ${op.count} column(s) at ${colToLetters(op.at)}`;
    case 'add_table':
      return `added table ${op.name ?? ''} (${op.rows}×${op.cols})`;
    case 'delete_table':
      return `${t()}: deleted`;
    case 'set_pivot':
      return `${t()}: pivot ${op.spec ? 'defined' : 'removed'}`;
    case 'set_filters':
      return `${t()}: filters ${op.filters?.length ? 'changed' : 'cleared'}`;
    case 'set_cond_formats':
      return `${t()}: conditional formatting (${op.rules?.length ?? 0} rules)`;
    case 'set_validations':
      return `${t()}: validation (${op.rules?.length ?? 0} rules)`;
    case 'set_name':
      return `name ${op.name} ${op.reference ? '= ' + op.reference : 'removed'}`;
    default:
      return op.type;
  }
}

function originLabel(o: string): string {
  switch (o) {
    case 'ai':
      return 'AI';
    case 'code':
      return 'code';
    case 'sql':
      return 'SQL';
    case 'import':
      return 'import';
    default:
      return '';
  }
}

export function HistoryPanel() {
  const fileId = useStore((s) => s.fileId);
  const fileName = useStore((s) => s.fileName);
  const historyCell = useStore((s) => s.historyCell);
  const tables = useStore((s) => s.tables);
  const seq = useStore((s) => s.seq);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewSeq, setPreviewSeq] = useState<number | null>(null);

  const tableName = (id: number) => tables.get(id)?.name ?? `table ${id}`;

  const refresh = async () => {
    if (!fileId) {
      setEntries([]);
      return;
    }
    try {
      if (historyCell) {
        const r = await api.files.cellHistory(fileId, historyCell.table, historyCell.row, historyCell.col);
        setEntries(r.entries);
      } else {
        const r = await api.files.history(fileId, 300);
        setEntries(r.entries);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, historyCell, seq]);

  const restore = async (at: number) => {
    if (!fileId) return;
    if (!confirm(`Restore the document as it was at change #${at}? The current state stays in the history (undo also works).`)) return;
    setBusy(true);
    try {
      const bundle = await api.files.replay(fileId, at);
      if (!bundle) throw new Error('no history for this document');
      const json = await book.replayDocument(bundle.json, bundle.ops.map((e) => e.op as Op), fileName);
      // load into the live document as a new snapshot (so other editors follow and the log records it)
      const st = getState();
      await book.loadBook(json, st.fileName, st.fileId, { keepView: true });
      book.announceSnapshot(`restored version #${at}`);
      setStatus(`Restored version #${at}`, 3000);
    } catch (e) {
      setStatus(`Restore failed: ${(e as Error).message}`, 6000);
    } finally {
      setBusy(false);
    }
  };

  const preview = async (at: number) => {
    if (!fileId) return;
    setBusy(true);
    try {
      const bundle = await api.files.replay(fileId, at);
      if (!bundle) throw new Error('no history');
      const json = await book.replayDocument(bundle.json, bundle.ops.map((e) => e.op as Op), fileName);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${fileName}-v${at}.gridwright.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setPreviewSeq(at);
    } catch (e) {
      setStatus(`Could not build that version: ${(e as Error).message}`, 6000);
    } finally {
      setBusy(false);
    }
  };

  if (!fileId) {
    return (
      <div className="panel">
        <div className="panel-title">History</div>
        <p className="muted">Save the document to start its audit trail: every change is then recorded with who made it, when, and whether it came from a person, the AI assistant or a code cell.</p>
      </div>
    );
  }

  return (
    <div className="panel history-panel">
      <div className="panel-title">
        <span>{historyCell ? `History of ${tableName(historyCell.table)}::${a1(historyCell.row, historyCell.col)}` : 'History'}</span>
        <span className="grow" />
        {historyCell && (
          <button className="link" onClick={() => useStore.setState({ historyCell: null })}>
            whole document
          </button>
        )}
        <button onClick={() => void refresh()} title="Refresh">
          ↻
        </button>
      </div>
      {error && <div className="err small">{error}</div>}
      <div className="muted small">{entries.length} change{entries.length === 1 ? '' : 's'} · log position {seq}</div>
      <ul className="history-list">
        {entries.map((e) => (
          <li key={e.seq} className={e.checkpoint ? 'checkpoint' : ''}>
            <div className="history-head">
              <span className="seq">#{e.seq}</span>
              <span className="who" title={e.author.login ?? e.author.id}>
                {e.author.name}
                {e.author.login ? ` (${e.author.login})` : ''}
              </span>
              {originLabel(e.origin) && <span className={`pill origin-${e.origin}`}>{originLabel(e.origin)}</span>}
              <span className="grow" />
              <span className="muted small">{new Date(e.ts).toLocaleString()}</span>
            </div>
            <div className="history-body">{describe(e, tableName)}</div>
            <div className="history-actions">
              <button className="link small" disabled={busy} onClick={() => void preview(e.seq)}>
                download as of here
              </button>
              <button className="link small" disabled={busy} onClick={() => void restore(e.seq)}>
                restore
              </button>
            </div>
          </li>
        ))}
        {!entries.length && <li className="muted">No changes recorded yet.</li>}
      </ul>
      {previewSeq !== null && <div className="muted small">Downloaded the document as of #{previewSeq}.</div>}
    </div>
  );
}
