import { useState } from 'react';
import { layoutOf } from '../grid/geometry';
import { fitAll, fitSelection, goTo, goToChart, jumpToTable, resetZoom } from '../grid/actions';
import { setStatus, useStore } from '../state/store';
import { PanelHeader } from './PanelHeader';

/** Where things are: every table and chart, one click away; the view fitted to any of them. */
export function NavigatePanel() {
  const tables = useStore((s) => s.tables);
  const charts = useStore((s) => s.charts);
  const selection = useStore((s) => s.selection);
  const zoom = useStore((s) => s.zoom);
  const [q, setQ] = useState('');
  const list = [...tables.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  const filtered = q.trim() ? list.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase())) : list;
  return (
    <div className="panel navigate-panel">
      <PanelHeader title="Tables and charts" subtitle={`${tables.size} table${tables.size === 1 ? '' : 's'} · ${charts.length} chart${charts.length === 1 ? '' : 's'}`} />
      <div className="row">
        <input
          className="grow"
          placeholder="Table name or reference (Vehicles, FX::B2, Checks::A1:B9)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              if (goTo(q)) setQ('');
              else if (filtered.length === 1) (jumpToTable(filtered[0].id), setQ(''));
              else setStatus(`No table or reference called “${q.trim()}”`, 4000);
            }
          }}
        />
      </div>
      <div className="row wrap">
        <button onClick={() => fitSelection()} disabled={!selection} title="Zoom to the selected cells (a single cell fits its table)">
          Fit selection
        </button>
        <button onClick={() => fitAll()} disabled={!tables.size} title="Zoom to show every table and chart">
          Fit all
        </button>
        <button onClick={() => resetZoom()} disabled={Math.abs(zoom - 1) < 0.001} title="Back to 100 %">
          Reset 100%
        </button>
      </div>
      <h4>Tables</h4>
      {filtered.map((t) => {
        const L = layoutOf(t);
        void L;
        return (
          <button key={t.id} className={`list-item nav-item ${selection?.table === t.id ? 'current' : ''}`} onClick={() => jumpToTable(t.id)} title="Select and fit this table">
            <b>{t.name}</b>
            <span className="muted small">
              {' '}
              {t.rows} × {t.cols}
              {t.pivot ? ' · pivot' : ''}
              {t.signoffs?.length ? ` · ${t.signoffs.length} sign-off${t.signoffs.length === 1 ? '' : 's'}` : ''}
            </span>
          </button>
        );
      })}
      {!filtered.length && <div className="muted small">No table matches.</div>}
      {charts.length > 0 && <h4>Charts</h4>}
      {charts.map((c) => (
        <button key={c.id} className="list-item nav-item" onClick={() => goToChart(c.id)} title="Select this chart">
          <b>{c.title || c.exhibit || `Chart ${c.id}`}</b>
          <span className="muted small"> {c.kind}</span>
        </button>
      ))}
    </div>
  );
}
