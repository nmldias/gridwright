// Placing tables in a workbook: shared by a run's outputs and by merge analyses (comparisons,
// reconciliations, appended series). Each placed table keeps its source and steps, so a
// right-click on it explains how it was made.
import { useEffect, useState } from 'react';
import { fmtNum, type DatasetMeta } from '../../api/datasets';
import { useStore } from '../../state/store';
import { apply } from '../../engine/book';
import { newFile, saveCurrentFile } from '../files';
import { plural } from './common';
import type { Model } from './model';

export interface PlaceItem {
  key: string;
  label: string;
  rows: number;
  /** chosen by default */
  place?: boolean;
}
type Placement = DatasetMeta['placements'][number];

export function PlaceTables({
  m,
  items,
  resetKey,
  ready = true,
  title = 'Place in the workbook',
  help = 'Each table becomes a sheet table, with its source and steps attached.',
  name,
  onPlace,
}: {
  m: Model;
  items: PlaceItem[];
  /** the chosen tables reset when this changes (another run, another merge) */
  resetKey: string;
  ready?: boolean;
  title?: string;
  help?: string;
  /** the name of a new workbook */
  name?: string;
  onPlace: (doc: string, keys: string[], cap: number) => Promise<{ placement: Placement }>;
}) {
  const fileId = useStore((s) => s.fileId);
  const fileName = useStore((s) => s.fileName);
  const permission = useStore((s) => s.permission);
  const defaults = () => new Set(items.filter((o) => o.place !== false && o.rows > 0).map((o) => o.key));
  const [chosen, setChosen] = useState<Set<string>>(defaults);
  const [cap, setCap] = useState(10_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // an unsaved scratch workbook is not where an import belongs: default to a new workbook named after the file
  const [where, setWhere] = useState<'new' | 'this'>(() => (useStore.getState().fileId ? 'this' : 'new'));
  const newName = (name ?? m.meta?.name ?? 'Import').slice(0, 80);
  useEffect(() => {
    setChosen(defaults());
    setMsg(null);
  }, [resetKey]);
  if (!m.canEdit) return null;
  const canWrite = where === 'new' || !fileId || permission === 'own' || permission === 'edit';
  const big = items.filter((o) => chosen.has(o.key) && o.rows > cap);
  const group = `place-where-${resetKey}`;
  const place = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (where === 'new') {
        await newFile(newName, useStore.getState().fileFolder);
        // a new workbook starts with a sample table: the import starts on a clean sheet instead
        for (const id of [...useStore.getState().tables.keys()]) apply({ type: 'delete_table', table: id });
        await saveCurrentFile();
        setWhere('this');
      } else if (!useStore.getState().fileId) await saveCurrentFile();
      const doc = useStore.getState().fileId;
      if (!doc) throw new Error('save the workbook first');
      const r = await onPlace(doc, items.filter((o) => chosen.has(o.key)).map((o) => o.key), cap);
      window.dispatchEvent(new Event('gw-imported'));
      const cut = r.placement.tables.filter((t) => t.truncated);
      setMsg({ ok: true, text: `Placed ${plural(r.placement.tables.length, 'table')} in “${useStore.getState().fileName}”${cut.length ? ` (${cut.map((t) => t.name).join(', ')} cut to ${fmtNum(cap)} rows — the full table stays here and in the CSV)` : ''}. Right-click a placed table and choose “How was this made?” to see its steps.` });
      void m.reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="side-card place-card">
      <h3 className="studio-h3">{title}</h3>
      <div className="muted small">{help}</div>
      <div className="place-where small" role="radiogroup" aria-label="Where to place the tables">
        <label className="field check">
          <input type="radio" name={group} checked={where === 'new'} onChange={() => setWhere('new')} /> A new workbook “{newName}”
        </label>
        <label className="field check">
          <input type="radio" name={group} checked={where === 'this'} onChange={() => setWhere('this')} /> This workbook “{fileName}”
        </label>
      </div>
      {items.map((o) => (
        <label key={o.key} className="field check small">
          <input
            type="checkbox"
            checked={chosen.has(o.key)}
            disabled={!o.rows}
            onChange={(e) => {
              const n = new Set(chosen);
              if (e.target.checked) n.add(o.key);
              else n.delete(o.key);
              setChosen(n);
            }}
          />
          <span className="grow">{o.label}</span>
          <span className="muted num">{fmtNum(o.rows)}</span>
        </label>
      ))}
      <label className="field small">
        <span>Rows per table at most</span>
        <select value={cap} onChange={(e) => setCap(Number(e.target.value))}>
          {[1_000, 10_000, 25_000, 50_000].map((n) => (
            <option key={n} value={n}>
              {fmtNum(n)}
            </option>
          ))}
        </select>
      </label>
      {big.length > 0 && <div className="amber-text small">{big.map((o) => o.label).join(', ')} will be cut to the first {fmtNum(cap)} rows in the sheet; summaries are usually what belongs in a workbook.</div>}
      {!canWrite && <div className="err small">This workbook is shared with you read-only.</div>}
      <button className="primary" disabled={busy || !chosen.size || !canWrite || !ready} onClick={() => void place()}>
        {busy ? 'Placing…' : where === 'new' ? `Create the workbook and place ${plural(chosen.size, 'table')}` : fileId ? `Place ${plural(chosen.size, 'table')}` : `Save the workbook and place`}
      </button>
      {msg && <div className={`small ${msg.ok ? 'green-text' : 'err'}`}>{msg.text}</div>}
    </section>
  );
}
