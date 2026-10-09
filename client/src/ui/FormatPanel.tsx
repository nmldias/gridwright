import { useEffect, useState } from 'react';
import * as book from '../engine/book';
import { a1, parseA1, refText, type CondFormat, type CondFormatKind, type Validation, type ValidationKind } from '../engine/types';
import { setStatus, useStore } from '../state/store';

const CF_KINDS: { value: CondFormatKind; label: string }[] = [
  { value: 'cell_is', label: 'Cell value is…' },
  { value: 'text', label: 'Text…' },
  { value: 'color_scale', label: 'Colour scale (min → max)' },
  { value: 'top', label: 'Top N values' },
  { value: 'bottom', label: 'Bottom N values' },
  { value: 'duplicate', label: 'Duplicate values' },
  { value: 'blank', label: 'Blank cells' },
  { value: 'not_blank', label: 'Non-blank cells' },
  { value: 'formula', label: 'Formula is true' },
];
const NUM_OPS = [
  ['gt', '>'],
  ['ge', '≥'],
  ['lt', '<'],
  ['le', '≤'],
  ['eq', '='],
  ['ne', '≠'],
  ['between', 'between'],
  ['not_between', 'not between'],
];
const TEXT_OPS = [
  ['contains', 'contains'],
  ['not_contains', 'does not contain'],
  ['starts', 'starts with'],
  ['ends', 'ends with'],
];
const V_KINDS: { value: ValidationKind; label: string }[] = [
  { value: 'list', label: 'List of allowed values' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Whole number' },
  { value: 'date', label: 'Date' },
  { value: 'text_length', label: 'Text length' },
];
const FILLS = ['#fee2e2', '#fef3c7', '#dcfce7', '#dbeafe', '#ede9fe', '#fce7f3', '#f3f4f6'];

function rangeLabel(r: { r0: number; c0: number; r1: number; c1: number }) {
  return `${a1(r.r0, r.c0)}${r.r0 !== r.r1 || r.c0 !== r.c1 ? ':' + a1(r.r1, r.c1) : ''}`;
}

export function FormatPanel() {
  const selection = useStore((s) => s.selection);
  const tables = useStore((s) => s.tables);
  const names = useStore((s) => s.names);
  const meta = selection ? tables.get(selection.table) : undefined;
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();

  // --- conditional format draft -------------------------------------------------------
  const [cf, setCf] = useState<{ kind: CondFormatKind; op: string; v1: string; v2: string; fill: string; color: string; bold: boolean; min: string; max: string }>({
    kind: 'cell_is',
    op: 'gt',
    v1: '',
    v2: '',
    fill: '#fee2e2',
    color: '',
    bold: false,
    min: '#f8fafc',
    max: '#0c447c',
  });
  // --- validation draft --------------------------------------------------------------
  const [vd, setVd] = useState<{ kind: ValidationKind; op: string; v1: string; v2: string; list: string; allowBlank: boolean; strict: boolean; message: string }>({
    kind: 'list',
    op: 'between',
    v1: '',
    v2: '',
    list: '',
    allowBlank: true,
    strict: true,
    message: '',
  });
  // --- names ---------------------------------------------------------------------------
  const [nameDraft, setNameDraft] = useState({ name: '', reference: '' });
  useEffect(() => {
    if (selection && meta) setNameDraft((d) => ({ ...d, reference: refText(meta.name, selection.r0, selection.c0, selection.r1, selection.c1) }));
  }, [selection, meta]);

  if (!meta || !selection) {
    return (
      <div className="panel">
        <div className="panel-title">Format</div>
        <p className="muted">Select a range to add conditional formatting or validation rules.</p>
      </div>
    );
  }
  const sel = selection;

  const addCf = () => {
    const rule: CondFormat = {
      r0: sel.r0,
      c0: sel.c0,
      r1: sel.r1,
      c1: sel.c1,
      kind: cf.kind,
      op: cf.kind === 'cell_is' ? cf.op : cf.kind === 'text' ? (TEXT_OPS.some(([k]) => k === cf.op) ? cf.op : 'contains') : undefined,
      values: cf.kind === 'cell_is' ? [cf.v1, cf.v2] : cf.kind === 'text' || cf.kind === 'top' || cf.kind === 'bottom' || cf.kind === 'formula' ? [cf.v1] : [],
      fill: cf.kind === 'color_scale' ? undefined : cf.fill || undefined,
      color: cf.color || undefined,
      bold: cf.bold ? true : undefined,
      min_color: cf.kind === 'color_scale' ? cf.min : undefined,
      max_color: cf.kind === 'color_scale' ? cf.max : undefined,
    };
    book.apply({ type: 'set_cond_formats', table: meta.id, rules: [...meta.cond_formats, rule] });
  };
  const removeCf = (i: number) => book.apply({ type: 'set_cond_formats', table: meta.id, rules: meta.cond_formats.filter((_, j) => j !== i) });

  const addVd = () => {
    let values: string[] = [];
    if (vd.kind === 'list') {
      const raw = vd.list.trim();
      values = parseA1(raw.replace(/^=/, '')) ? [raw] : raw.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
      if (!values.length) {
        setStatus('Enter the allowed values (comma separated) or a range such as Lists::A2:A20');
        return;
      }
    } else values = [vd.v1, vd.v2];
    const rule: Validation = {
      r0: sel.r0,
      c0: sel.c0,
      r1: sel.r1,
      c1: sel.c1,
      kind: vd.kind,
      op: vd.kind === 'list' ? undefined : vd.op,
      values,
      allow_blank: vd.allowBlank,
      strict: vd.strict,
      message: vd.message.trim() || undefined,
    };
    book.apply({ type: 'set_validations', table: meta.id, rules: [...meta.validations, rule] });
  };
  const removeVd = (i: number) => book.apply({ type: 'set_validations', table: meta.id, rules: meta.validations.filter((_, j) => j !== i) });

  const defineName = () => {
    const n = nameDraft.name.trim();
    if (!n) return;
    const ch = book.apply({ type: 'set_name', name: n, reference: nameDraft.reference.trim() || null });
    if (!ch.error) setNameDraft({ name: '', reference: nameDraft.reference });
  };

  const describeCf = (r: CondFormat) => {
    const k = CF_KINDS.find((x) => x.value === r.kind)?.label ?? r.kind;
    const op = r.op ? ([...NUM_OPS, ...TEXT_OPS].find(([x]) => x === r.op)?.[1] ?? r.op) : '';
    const vals = r.values.filter(Boolean).join(' and ');
    return `${rangeLabel(r)}: ${k.replace('…', '')} ${op} ${vals}`.trim();
  };
  const describeVd = (r: Validation) => {
    const k = V_KINDS.find((x) => x.value === r.kind)?.label ?? r.kind;
    const op = r.op ? NUM_OPS.find(([x]) => x === r.op)?.[1] ?? r.op : '';
    const vals = r.kind === 'list' ? r.values.join(', ') : r.values.filter(Boolean).join(' and ');
    return `${rangeLabel(r)}: ${k} ${op} ${vals}${r.strict ? ' (strict)' : ''}`;
  };

  return (
    <div className="panel format-panel">
      <div className="panel-title">Format · {meta.name}</div>
      <div className="muted small">Rules apply to the selection {rangeLabel(sel)} when added.</div>

      <div className="panel-subtitle">Conditional formatting</div>
      <ul className="rule-list">
        {meta.cond_formats.map((r, i) => (
          <li key={i}>
            <span className="swatch-dot" style={{ background: r.fill ?? r.max_color ?? '#fff', borderColor: r.color ?? '#d1d5db' }} />
            <span className="grow small">{describeCf(r)}</span>
            <button className="icon" title="Remove" onClick={() => removeCf(i)}>
              ×
            </button>
          </li>
        ))}
        {!meta.cond_formats.length && <li className="muted small">No rules on this table.</li>}
      </ul>
      <div className="rule-form">
        <select value={cf.kind} onChange={(e) => setCf({ ...cf, kind: e.target.value as CondFormatKind, op: e.target.value === 'text' ? 'contains' : 'gt' })}>
          {CF_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        {cf.kind === 'cell_is' && (
          <div className="row">
            <select value={cf.op} onChange={(e) => setCf({ ...cf, op: e.target.value })}>
              {NUM_OPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input value={cf.v1} onKeyDown={stop} placeholder="value" onChange={(e) => setCf({ ...cf, v1: e.target.value })} />
            {(cf.op === 'between' || cf.op === 'not_between') && <input value={cf.v2} onKeyDown={stop} placeholder="and" onChange={(e) => setCf({ ...cf, v2: e.target.value })} />}
          </div>
        )}
        {cf.kind === 'text' && (
          <div className="row">
            <select value={cf.op} onChange={(e) => setCf({ ...cf, op: e.target.value })}>
              {TEXT_OPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input value={cf.v1} onKeyDown={stop} placeholder="text" onChange={(e) => setCf({ ...cf, v1: e.target.value })} />
          </div>
        )}
        {(cf.kind === 'top' || cf.kind === 'bottom') && <input value={cf.v1} onKeyDown={stop} placeholder="N (e.g. 10)" onChange={(e) => setCf({ ...cf, v1: e.target.value })} />}
        {cf.kind === 'formula' && <input value={cf.v1} onKeyDown={stop} placeholder='=A2>B2 (relative to the top-left cell)' onChange={(e) => setCf({ ...cf, v1: e.target.value })} />}
        {cf.kind === 'color_scale' ? (
          <div className="row">
            <label className="field">
              <span>Min colour</span>
              <input type="color" value={cf.min} onChange={(e) => setCf({ ...cf, min: e.target.value })} />
            </label>
            <label className="field">
              <span>Max colour</span>
              <input type="color" value={cf.max} onChange={(e) => setCf({ ...cf, max: e.target.value })} />
            </label>
          </div>
        ) : (
          <div className="row wrap">
            <div className="swatches" title="Fill">
              {FILLS.map((c) => (
                <button key={c} className={`swatch ${cf.fill === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setCf({ ...cf, fill: c })} />
              ))}
              <button className={`swatch ${cf.fill === '' ? 'on' : ''}`} style={{ background: 'white' }} onClick={() => setCf({ ...cf, fill: '' })}>
                ×
              </button>
            </div>
            <label className="field check">
              <input type="checkbox" checked={cf.bold} onChange={(e) => setCf({ ...cf, bold: e.target.checked })} />
              <span>bold</span>
            </label>
            <label className="field check">
              <input type="checkbox" checked={cf.color === '#b91c1c'} onChange={(e) => setCf({ ...cf, color: e.target.checked ? '#b91c1c' : '' })} />
              <span>red text</span>
            </label>
          </div>
        )}
        <button className="primary" onClick={addCf}>
          Add rule to {rangeLabel(sel)}
        </button>
      </div>

      <div className="panel-subtitle">Data validation</div>
      <ul className="rule-list">
        {meta.validations.map((r, i) => (
          <li key={i}>
            <span className="grow small">{describeVd(r)}</span>
            <button className="icon" title="Remove" onClick={() => removeVd(i)}>
              ×
            </button>
          </li>
        ))}
        {!meta.validations.length && <li className="muted small">No validation on this table.</li>}
      </ul>
      <div className="rule-form">
        <select value={vd.kind} onChange={(e) => setVd({ ...vd, kind: e.target.value as ValidationKind })}>
          {V_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        {vd.kind === 'list' ? (
          <input value={vd.list} onKeyDown={stop} placeholder="North, South, East  —  or a range: Lists::A2:A20" onChange={(e) => setVd({ ...vd, list: e.target.value })} />
        ) : (
          <div className="row">
            <select value={vd.op} onChange={(e) => setVd({ ...vd, op: e.target.value })}>
              {NUM_OPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input value={vd.v1} onKeyDown={stop} placeholder={vd.kind === 'date' ? '2026-01-01' : 'value or =ref'} onChange={(e) => setVd({ ...vd, v1: e.target.value })} />
            {(vd.op === 'between' || vd.op === 'not_between') && <input value={vd.v2} onKeyDown={stop} placeholder="and" onChange={(e) => setVd({ ...vd, v2: e.target.value })} />}
          </div>
        )}
        <input value={vd.message} onKeyDown={stop} placeholder="message shown when the value is refused (optional)" onChange={(e) => setVd({ ...vd, message: e.target.value })} />
        <div className="row wrap">
          <label className="field check">
            <input type="checkbox" checked={vd.strict} onChange={(e) => setVd({ ...vd, strict: e.target.checked })} />
            <span>reject invalid entries (otherwise they are only marked)</span>
          </label>
          <label className="field check">
            <input type="checkbox" checked={vd.allowBlank} onChange={(e) => setVd({ ...vd, allowBlank: e.target.checked })} />
            <span>allow blank</span>
          </label>
        </div>
        <button className="primary" onClick={addVd}>
          Add validation to {rangeLabel(sel)}
        </button>
      </div>

      <div className="panel-subtitle">Named ranges</div>
      <ul className="rule-list">
        {names.map((n) => (
          <li key={n.name}>
            <b className="small">{n.name}</b>
            <span className="grow small muted">= {n.reference}</span>
            <button className="icon" title="Remove" onClick={() => book.apply({ type: 'set_name', name: n.name, reference: null })}>
              ×
            </button>
          </li>
        ))}
        {!names.length && <li className="muted small">No names yet. Names can be used in formulas: =SUM(Revenue2026).</li>}
      </ul>
      <div className="row">
        <input value={nameDraft.name} onKeyDown={stop} placeholder="Name" style={{ width: 120 }} onChange={(e) => setNameDraft({ ...nameDraft, name: e.target.value })} />
        <input value={nameDraft.reference} onKeyDown={stop} placeholder="Table::A1:B9 or Orders[Amount]" onChange={(e) => setNameDraft({ ...nameDraft, reference: e.target.value })} />
        <button className="primary" onClick={defineName} disabled={!nameDraft.name.trim()}>
          Define
        </button>
      </div>
    </div>
  );
}
