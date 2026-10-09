import { useMemo } from 'react';
import { cellAt, useStore } from '../state/store';
import { formatNumberPlain } from '../engine/types';

export function StatusBar() {
  const status = useStore((s) => s.status);
  const selection = useStore((s) => s.selection);
  const tables = useStore((s) => s.tables);
  const cells = useStore((s) => s.cells);
  const presence = useStore((s) => s.presence);
  const runs = useStore((s) => s.runs);
  const fileId = useStore((s) => s.fileId);
  const zoom = useStore((s) => s.zoom);
  const me = useStore((s) => s.me);
  const cellsVersion = useStore((s) => s.cellsVersion);
  void cellsVersion;

  const stats = useMemo(() => {
    if (!selection) return null;
    const multi = selection.r0 !== selection.r1 || selection.c0 !== selection.c1;
    if (!multi) return null;
    let sum = 0;
    let count = 0;
    let n = 0;
    for (let r = selection.r0; r <= selection.r1; r++) {
      for (let c = selection.c0; c <= selection.c1; c++) {
        const cell = cellAt(selection.table, r, c);
        if (!cell || cell.v === null) continue;
        count++;
        if ('n' in cell.v) {
          sum += cell.v.n;
          n++;
        }
      }
    }
    return { sum, count, n };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, cells, cellsVersion]);

  const meta = selection ? tables.get(selection.table) : undefined;
  const running = Array.from(runs.values()).filter((r) => r.running).length;

  return (
    <div className="statusbar">
      <span className="status-msg">{status}</span>
      <span className="grow" />
      {running > 0 && <span className="pill loading">{running} cell{running > 1 ? 's' : ''} running</span>}
      {presence.size > 0 && <span className="pill" title={Array.from(presence.values()).map((p) => p.name).join(', ')}>{presence.size} other{presence.size > 1 ? 's' : ''} online</span>}
      {me.identity && me.login && <span className="muted" title={`signed in as ${me.login} (${me.role})`}>{me.name || me.login}</span>}
      {!fileId && <span className="muted">unsaved document</span>}
      {meta && (
        <span className="muted">
          {meta.name} · {meta.rows} × {meta.cols}
        </span>
      )}
      {stats && stats.n > 0 && (
        <span className="muted">
          Sum {formatNumberPlain(Math.round(stats.sum * 1e6) / 1e6)} · Avg {formatNumberPlain(Math.round((stats.sum / stats.n) * 1e6) / 1e6)} · Count {stats.count}
        </span>
      )}
      {stats && stats.n === 0 && <span className="muted">Count {stats.count}</span>}
      <span className="muted" title="Zoom: Ctrl + wheel">
        {Math.round(zoom * 100)}%
      </span>
    </div>
  );
}
