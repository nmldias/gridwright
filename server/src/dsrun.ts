// Running a recipe: the steps, one by one, over a working table built from the raw sheet. Each step is
// compiled here to SQL with checked column names and bound values, runs in its own transaction, and
// leaves a record: rows in and out, cells changed, values rejected (kept, with their row in the file),
// examples before and after. Checks record what fails; outputs are tables (out_<key>). The run
// database is self-contained: the steps it ran (_steps), every issue (_issues), every removed row
// (_removed), every check (_checks) — the audit of how each output was made.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { SheetMeta } from './dsengine.js';
import { slug } from './dsprofile.js';
import { describe, type ColumnMeta, type Cond, type OutputMeta, type Step, type StepResult } from './dssteps.js';

export interface CheckResult {
  step: string;
  label: string;
  severity: 'info' | 'warning' | 'error';
  failing: number;
  total: number;
}

export interface RunOutput {
  ok: boolean;
  failedAt?: string;
  results: StepResult[];
  columns: ColumnMeta[];
  rows: number;
  outputs: OutputMeta[];
  checks: CheckResult[];
  unit?: string;
  sample?: number;
  preview?: { work: Preview; outputs: Record<string, Preview> };
  ms: number;
}
export interface Preview {
  columns: ColumnMeta[];
  rows: unknown[][];
  total: number;
}

const AMOUNT = /valor|total|amount|montante|pre[cç]o|price|custo|cost|saldo|balance|imposto|tax|iva|vat|l[ií]quido|net|bruto|gross|pago|paid/i;
type V = SQLInputValue;

class Ctx {
  cols: ColumnMeta[] = [];
  unit?: string;
  constructor(
    readonly db: DatabaseSync,
    readonly sheets: SheetMeta[],
    readonly sample?: number,
  ) {}
  has(k: string) {
    return this.cols.some((c) => c.key === k);
  }
  col(k: string): ColumnMeta {
    const c = this.cols.find((x) => x.key === k);
    if (!c) throw new Error(`the column “${k}” is not in the data at this step`);
    return c;
  }
  q(k: string) {
    this.col(k);
    return `"${k}"`;
  }
  count(where = '1', params: V[] = []) {
    return Number((this.db.prepare(`SELECT count(*) n FROM work WHERE ${where}`).get(...params) as { n: number }).n);
  }
  add(meta: ColumnMeta) {
    if (this.has(meta.key)) throw new Error(`a column “${meta.key}” already exists`);
    this.db.exec(`ALTER TABLE work ADD COLUMN "${meta.key}"`);
    this.cols.push(meta);
  }
  label = (k: string) => this.cols.find((c) => c.key === k)?.label ?? k;
}

/** A condition list as SQL (ANDed), its values pushed onto params. */
function condSql(ctx: Ctx, conds: Cond[] | undefined, params: V[], alias = ''): string {
  if (!conds?.length) return '1';
  return conds
    .map((c) => {
      const col = `${alias}${ctx.q(c.column)}`;
      const val = (x: unknown) => {
        params.push(x as V);
        return '?';
      };
      switch (c.op) {
        case 'eq':
          return `${col} = ${val(c.value ?? null)}`;
        case 'neq':
          return `${col} IS NOT ${val(c.value ?? null)}`;
        case 'in':
        case 'not_in': {
          const vs = c.values ?? (c.value !== undefined ? [c.value] : []);
          if (!vs.length) return c.op === 'in' ? '0' : '1';
          const list = vs.map((x) => val(x)).join(', ');
          // a blank is not one of the values: "not in" keeps it
          return c.op === 'in' ? `${col} IN (${list})` : `(${col} IS NULL OR ${col} NOT IN (${list}))`;
        }
        case 'gt':
          return `${col} > ${val(c.value ?? null)}`;
        case 'gte':
          return `${col} >= ${val(c.value ?? null)}`;
        case 'lt':
          return `${col} < ${val(c.value ?? null)}`;
        case 'lte':
          return `${col} <= ${val(c.value ?? null)}`;
        case 'is_null':
          return `${col} IS NULL`;
        case 'not_null':
          return `${col} IS NOT NULL`;
        case 'contains':
          return `instr(lower(CAST(${col} AS TEXT)), lower(${val(String(c.value ?? ''))})) > 0`;
      }
    })
    .map((s) => `(${s})`)
    .join(' AND ');
}

const fmt = (n: number) => n.toLocaleString('en-GB');
const ex = (rows: Record<string, unknown>[], column?: string) => rows.map((r) => ({ row: Number(r._row), column, before: (r.b ?? null) as string | number | null, after: (r.a ?? null) as string | number | null }));

function issue(ctx: Ctx, step: string, kind: string, severity: string, where: string, params: V[], column: string | null, detail: string, limit = 50_000): number {
  const r = ctx.db.prepare(`INSERT INTO _issues (step, kind, severity, row, col, value, detail) SELECT ?, ?, ?, _row, ?, ${column ? `"${column}"` : 'NULL'}, ? FROM work WHERE ${where} ORDER BY _row LIMIT ${limit}`).run(step, kind, severity, column, detail, ...params);
  return Number(r.changes);
}

function inferTypes(ctx: Ctx) {
  const parts = ctx.cols.map((c, i) => `count("${c.key}") f${i}, total(typeof("${c.key}") IN ('integer','real')) n${i}, total(gw_isdate("${c.key}")) d${i}`);
  if (!parts.length) return;
  const r = ctx.db.prepare(`SELECT ${parts.join(', ')} FROM work`).get() as Record<string, number>;
  ctx.cols.forEach((c, i) => {
    const f = Number(r[`f${i}`]);
    c.type = f === 0 ? 'empty' : Number(r[`n${i}`]) >= f * 0.98 ? 'number' : Number(r[`d${i}`]) >= f * 0.98 ? 'date' : 'text';
  });
}

type Exec = (ctx: Ctx, s: Step, r: StepResult) => void;

const steps: { [K in Step['type']]: (ctx: Ctx, s: Extract<Step, { type: K }>, r: StepResult) => void } = {
  header(ctx, s, r) {
    const sheet = ctx.sheets[s.sheet];
    if (!sheet) throw new Error(`the file has no sheet ${s.sheet + 1}`);
    const missing = s.columns.filter((c) => c.index >= sheet.cols);
    const sel = s.columns.map((c) => (c.index < sheet.cols ? `c${c.index} AS "${c.key}"` : `NULL AS "${c.key}"`)).join(', ');
    ctx.db.exec('DROP TABLE IF EXISTS work');
    const lim = ctx.sample ? ` LIMIT ${Number(ctx.sample)}` : '';
    ctx.db.prepare(`CREATE TABLE work AS SELECT _r AS _row, ${sel} FROM src.raw_${s.sheet} WHERE _r > ? ORDER BY _r${lim}`).run(s.row);
    r.rowsIn = Number((ctx.db.prepare(`SELECT count(*) n FROM src.raw_${s.sheet} WHERE _r > ?`).get(s.row) as { n: number }).n);
    ctx.cols = s.columns.map((c) => ({ key: c.key, label: c.label, type: 'text', source: { header: c.label, index: c.index } }));
    inferTypes(ctx);
    r.rowsOut = ctx.count();
    r.notes.push(`Sheet “${sheet.name}”, header on row ${s.row}: ${s.columns.length} of ${sheet.cols} columns read; ${fmt(r.rowsIn)} data rows in the file${ctx.sample ? ` (preview on the first ${fmt(r.rowsOut)})` : ''}.`);
    if (missing.length) r.notes.push(`Not in this file: ${missing.map((m) => m.label).join(', ')} (left blank).`);
  },
  trim(ctx, s, r) {
    const targets = (s.columns === 'all' ? ctx.cols.filter((c) => c.type === 'text' || c.type === 'identifier') : s.columns.map((k) => ctx.col(k))).map((c) => c.key);
    for (const k of targets) {
      const where = `typeof("${k}") = 'text' AND "${k}" IS NOT gw_clean("${k}")`;
      if (r.examples.length < 5) r.examples.push(...ex(ctx.db.prepare(`SELECT _row, "${k}" b, gw_clean("${k}") a FROM work WHERE ${where} LIMIT 2`).all() as Record<string, unknown>[], k));
      r.changed += Number(ctx.db.prepare(`UPDATE work SET "${k}" = gw_clean("${k}") WHERE ${where}`).run().changes);
    }
    r.notes.push(r.changed ? `${fmt(r.changed)} cells tidied in ${targets.length} columns.` : `Nothing to tidy in ${targets.length} text columns.`);
  },
  drop_rows(ctx, s, r) {
    const params: V[] = [];
    const dataCols = ctx.cols.map((c) => `"${c.key}"`);
    let where: string;
    if (s.when === 'empty') where = dataCols.length ? dataCols.map((c) => `${c} IS NULL`).join(' AND ') : '0';
    else if (s.when === 'totals') {
      const text = ctx.cols.filter((c) => c.type !== 'number' && c.type !== 'date').map((c) => `gw_istotal("${c.key}")`);
      where = text.length ? text.join(' OR ') : '0';
    } else where = condSql(ctx, s.where, params);
    r.examples = (ctx.db.prepare(`SELECT _row FROM work WHERE ${where} ORDER BY _row LIMIT 5`).all(...params) as { _row: number }[]).map((x) => ({ row: Number(x._row), note: 'removed' }));
    ctx.db.prepare(`INSERT INTO _removed (step, row, reason) SELECT ?, _row, ? FROM work WHERE ${where}`).run(s.id, s.when, ...params);
    r.changed = Number(ctx.db.prepare(`DELETE FROM work WHERE ${where}`).run(...params).changes);
    r.notes.push(r.changed ? `${fmt(r.changed)} rows set aside (kept in the audit with their row in the file).` : 'No rows matched.');
  },
  convert(ctx, s, r) {
    const c = ctx.col(s.column);
    const k = `"${c.key}"`;
    if (s.to === 'number') {
      let locale = s.locale;
      if (locale === 'auto') {
        const n = ctx.db.prepare(`SELECT total(gw_numclass(${k}) = 'pt') pt, total(gw_numclass(${k}) = 'en') en FROM work WHERE typeof(${k}) = 'text'`).get() as { pt: number; en: number };
        locale = Number(n.en) > Number(n.pt) ? 'en' : 'pt';
        r.notes.push(`Format detected: ${locale === 'pt' ? 'Portuguese (1.234,56)' : 'English (1,234.56)'} — ${fmt(Number(locale === 'pt' ? n.pt : n.en))} values written that way.`);
      }
      r.examples = ex(ctx.db.prepare(`SELECT _row, ${k} b, gw_num(${k}, ?) a FROM work WHERE typeof(${k}) = 'text' AND gw_num(${k}, ?) IS NOT NULL LIMIT 3`).all(locale, locale) as Record<string, unknown>[], c.key);
      r.rejected = issue(ctx, s.id, 'rejected', 'warning', `${k} IS NOT NULL AND gw_num(${k}, ?) IS NULL`, [locale], c.key, `not a number in the ${locale === 'pt' ? 'Portuguese' : 'English'} format`);
      const already = ctx.count(`typeof(${k}) IN ('integer','real')`);
      r.changed = Number(ctx.db.prepare(`UPDATE work SET ${k} = gw_num(${k}, ?) WHERE ${k} IS NOT NULL AND typeof(${k}) NOT IN ('integer','real')`).run(locale).changes) - r.rejected;
      c.type = 'number';
      if (ctx.unit && AMOUNT.test(c.label)) c.unit = ctx.unit;
      r.notes.push(`${fmt(r.changed)} values written as text became numbers; ${fmt(already)} were numbers already${r.rejected ? `; ${fmt(r.rejected)} could not be read and are listed as exceptions` : ''}.`);
    } else if (s.to === 'date') {
      const df = s.dayFirst ? 1 : 0;
      const pending = `${k} IS NOT NULL AND NOT (typeof(${k}) = 'text' AND gw_isdate(${k}) AND length(${k}) = 10)`;
      r.examples = ex(ctx.db.prepare(`SELECT _row, ${k} b, gw_date(${k}, ?) a FROM work WHERE ${pending} AND gw_date(${k}, ?) IS NOT NULL LIMIT 3`).all(df, df) as Record<string, unknown>[], c.key);
      r.rejected = issue(ctx, s.id, 'rejected', 'warning', `${k} IS NOT NULL AND gw_date(${k}, ?) IS NULL`, [df], c.key, 'not a date');
      r.changed = Number(ctx.db.prepare(`UPDATE work SET ${k} = gw_date(${k}, ?) WHERE ${pending}`).run(df).changes) - r.rejected;
      c.type = 'date';
      const span = ctx.db.prepare(`SELECT min(${k}) a, max(${k}) b FROM work`).get() as { a: string; b: string };
      r.notes.push(`${r.changed ? `${fmt(r.changed)} values rewritten as ISO dates; ` : 'Already dates; '}from ${span.a ?? '—'} to ${span.b ?? '—'}${r.rejected ? `; ${fmt(r.rejected)} not dates (exceptions)` : ''}.`);
    } else if (s.to === 'identifier' || s.to === 'text') {
      r.examples = ex(ctx.db.prepare(`SELECT _row, ${k} b, gw_ident(${k}) a FROM work WHERE typeof(${k}) IN ('integer','real') LIMIT 3`).all() as Record<string, unknown>[], c.key);
      r.changed = Number(ctx.db.prepare(`UPDATE work SET ${k} = gw_ident(${k}) WHERE typeof(${k}) IN ('integer','real')`).run().changes);
      c.type = s.to;
      r.notes.push(r.changed ? `${fmt(r.changed)} numbers kept as text so codes like “00123” and “C37” compare alike.` : 'Already text.');
    } else {
      const truthy = ['sim', 's', 'yes', 'y', 'true', '1', 'verdadeiro'];
      const falsy = ['não', 'nao', 'n', 'no', 'false', '0', 'falso'];
      const expr = `CASE WHEN lower(CAST(${k} AS TEXT)) IN (${truthy.map(() => '?').join(',')}) THEN 1 WHEN lower(CAST(${k} AS TEXT)) IN (${falsy.map(() => '?').join(',')}) THEN 0 END`;
      const p = [...truthy, ...falsy];
      r.rejected = issue(ctx, s.id, 'rejected', 'warning', `${k} IS NOT NULL AND (${expr}) IS NULL`, p, c.key, 'not yes/no');
      r.changed = Number(ctx.db.prepare(`UPDATE work SET ${k} = ${expr} WHERE ${k} IS NOT NULL`).run(...p).changes);
      c.type = 'boolean';
    }
  },
  drop_column(ctx, s, r) {
    const c = ctx.col(s.column);
    const d = ctx.db.prepare(`SELECT count(DISTINCT "${c.key}") n, min("${c.key}") v FROM work`).get() as { n: number; v: string };
    if (s.keepAs === 'unit') {
      if (Number(d.n) === 1) {
        ctx.unit = String(d.v);
        const amounts = ctx.cols.filter((x) => x.type === 'number' && AMOUNT.test(x.label));
        for (const a of amounts) a.unit = ctx.unit;
        r.notes.push(`“${c.label}” is always ${d.v}: kept as the unit of ${amounts.map((a) => a.label).join(', ') || 'the amounts'} instead of a column.`);
      } else r.notes.push(`“${c.label}” has ${fmt(Number(d.n))} values, not one: not used as a unit.`);
    } else r.notes.push(`“${c.label}” removed (${fmt(Number(d.n))} distinct values; still in the raw data).`);
    ctx.db.exec(`ALTER TABLE work DROP COLUMN "${c.key}"`);
    ctx.cols = ctx.cols.filter((x) => x.key !== c.key);
    r.changed = r.rowsIn;
  },
  rename(ctx, s, r) {
    const c = ctx.col(s.column);
    r.notes.push(`“${c.label}” is now “${s.label}”.`);
    c.label = s.label;
  },
  signed(ctx, s, r) {
    const c = ctx.col(s.column);
    if (c.type !== 'number') throw new Error(`read “${c.label}” as a number first`);
    const params: V[] = [];
    const when = condSql(ctx, s.negateWhen, params);
    ctx.add({ key: s.into.key, label: s.into.label, type: 'number', unit: c.unit });
    r.changed = ctx.count(when, params);
    ctx.db.prepare(`UPDATE work SET "${s.into.key}" = CASE WHEN ${when} THEN -("${c.key}") ELSE "${c.key}" END`).run(...params);
    r.examples = ex(ctx.db.prepare(`SELECT _row, "${c.key}" b, "${s.into.key}" a FROM work WHERE ${when} LIMIT 3`).all(...params) as Record<string, unknown>[], s.into.key);
    const t = ctx.db.prepare(`SELECT total("${c.key}") g, total("${s.into.key}") n FROM work`).get() as { g: number; n: number };
    r.notes.push(`${fmt(r.changed)} rows count negative. Gross ${fmt(Math.round(Number(t.g) * 100) / 100)} → net ${fmt(Math.round(Number(t.n) * 100) / 100)}${c.unit ? ` ${c.unit}` : ''}.`);
  },
  derive(ctx, s, r) {
    const from = ctx.col(s.from);
    const F = `"${from.key}"`;
    const params: V[] = [];
    let expr: string;
    let type: ColumnMeta['type'] = 'text';
    switch (s.kind) {
      case 'month':
      case 'quarter':
      case 'year':
      case 'weekday':
        if (from.type !== 'date') throw new Error(`read “${from.label}” as a date first`);
        expr = `gw_${s.kind}(${F})`;
        if (s.kind === 'year') type = 'number';
        break;
      case 'days_between': {
        if (!s.to) throw new Error('days between needs a second date');
        expr = `gw_days(${F}, ${ctx.q(s.to)})`;
        type = 'number';
        break;
      }
      case 'age_days': {
        let asOf = s.asOf ?? 'max';
        if (asOf === 'max') asOf = String((ctx.db.prepare(`SELECT max(${F}) m FROM work`).get() as { m: string }).m ?? '');
        r.notes.push(`Age measured at ${asOf}${s.asOf === 'max' || !s.asOf ? ' (the latest date in the file)' : ''}.`);
        expr = 'gw_days(' + F + ', ?)';
        params.push(asOf);
        type = 'number';
        break;
      }
      case 'extract':
        if (!s.pattern) throw new Error('extract needs a pattern');
        try {
          new RegExp(s.pattern, 'u');
        } catch {
          throw new Error(`the pattern “${s.pattern}” is not a valid regular expression`);
        }
        expr = 'gw_extract(' + F + ', ?)';
        params.push(s.pattern);
        break;
      case 'upper':
        expr = `upper(${F})`;
        break;
      case 'copy':
        expr = F;
        type = from.type;
        break;
      case 'prefix':
        expr = `substr(CAST(${F} AS TEXT), 1, ${Number(s.chars ?? 1)})`;
        break;
    }
    ctx.add({ key: s.into.key, label: s.into.label, type, unit: s.kind === 'copy' ? from.unit : type === 'number' ? (s.kind === 'year' ? undefined : 'days') : undefined });
    r.changed = Number(ctx.db.prepare(`UPDATE work SET "${s.into.key}" = ${expr}`).run(...params).changes);
    r.examples = ex(ctx.db.prepare(`SELECT _row, ${F} b, "${s.into.key}" a FROM work WHERE "${s.into.key}" IS NOT NULL LIMIT 3`).all() as Record<string, unknown>[], s.into.key);
    const d = ctx.db.prepare(`SELECT count(DISTINCT "${s.into.key}") n, count("${s.into.key}") f FROM work`).get() as { n: number; f: number };
    r.notes.push(`${fmt(Number(d.f))} values, ${fmt(Number(d.n))} distinct.`);
  },
  map_values(ctx, s, r) {
    const c = ctx.col(s.column);
    const target = s.into ? s.into.key : c.key;
    if (s.into) ctx.add({ key: s.into.key, label: s.into.label, type: 'text' });
    const params: V[] = [];
    const cases = s.map.map((m) => (params.push(m.from, m.to), 'WHEN ? THEN ?')).join(' ');
    const froms = s.map.map((m) => m.from);
    r.changed = ctx.count(`CAST("${c.key}" AS TEXT) IN (${froms.map(() => '?').join(',')})`, froms);
    ctx.db.prepare(`UPDATE work SET "${target}" = CASE CAST("${c.key}" AS TEXT) ${cases} ELSE "${c.key}" END`).run(...params);
    r.notes.push(`${fmt(r.changed)} cells mapped by ${s.map.length} rules.`);
  },
  canonical(ctx, s, r) {
    const code = `"${ctx.col(s.code).key}"`;
    const name = `"${ctx.col(s.name).key}"`;
    const db = ctx.db;
    db.exec(`DROP TABLE IF EXISTS temp._canon; DROP TABLE IF EXISTS temp._grp; DROP TABLE IF EXISTS temp._cg`);
    db.exec(`CREATE TEMP TABLE _canon AS SELECT code, name AS canon, total, names FROM (
      SELECT code, name, n, sum(n) OVER (PARTITION BY code) total, count(*) OVER (PARTITION BY code) names,
             row_number() OVER (PARTITION BY code ORDER BY n DESC, name) rn
      FROM (SELECT ${code} code, ${name} name, count(*) n FROM work WHERE ${code} IS NOT NULL AND ${name} IS NOT NULL GROUP BY 1, 2)) WHERE rn = 1`);
    db.exec('CREATE INDEX temp._canon_code ON _canon(code)');
    const variants = db.prepare(`SELECT code, json_group_array(name) names, json_group_array(n) counts FROM (SELECT ${code} code, ${name} name, count(*) n FROM work WHERE ${code} IS NOT NULL GROUP BY 1, 2 ORDER BY n DESC) GROUP BY code HAVING count(*) > 1 ORDER BY sum(n) DESC`).all() as { code: string; names: string; counts: string }[];
    for (const v of variants) {
      const names: string[] = JSON.parse(v.names);
      const counts: number[] = JSON.parse(v.counts);
      db.prepare(`INSERT INTO _issues (step, kind, severity, row, col, value, detail) VALUES (?, 'name-variants', 'info', NULL, ?, ?, ?)`).run(s.id, s.name, v.code, `${names.map((n, i) => `“${n}” (${fmt(counts[i])})`).join(' · ')} → kept “${names[0]}”`);
    }
    ctx.add({ key: s.into.key, label: s.into.label, type: 'text' });
    db.exec(`UPDATE work SET "${s.into.key}" = _canon.canon FROM _canon WHERE _canon.code = work.${code}`);
    db.exec(`UPDATE work SET "${s.into.key}" = ${name} WHERE "${s.into.key}" IS NULL`);
    r.changed = ctx.count(`${name} IS NOT "${s.into.key}"`);
    r.examples = ex(db.prepare(`SELECT _row, ${name} b, "${s.into.key}" a FROM work WHERE ${name} IS NOT "${s.into.key}" LIMIT 3`).all() as Record<string, unknown>[], s.into.key);
    r.issues = variants.length;
    r.notes.push(`${fmt(variants.length)} codes were written with more than one name; ${fmt(r.changed)} rows now use the name most used for their code.`);
    if (s.groupInto) {
      db.exec(`CREATE TEMP TABLE _grp AS SELECT k, label, codes FROM (SELECT gw_namekey(canon) k, canon label, count(*) OVER (PARTITION BY gw_namekey(canon)) codes, row_number() OVER (PARTITION BY gw_namekey(canon) ORDER BY total DESC) rn FROM _canon) WHERE rn = 1`);
      db.exec(`CREATE TEMP TABLE _cg AS SELECT c.code code, g.label label, g.codes codes FROM _canon c JOIN _grp g ON g.k = gw_namekey(c.canon)`);
      db.exec('CREATE INDEX temp._cg_code ON _cg(code)');
      const multi = db.prepare(`SELECT label, json_group_array(code) codes FROM _cg WHERE codes > 1 GROUP BY label ORDER BY count(*) DESC`).all() as { label: string; codes: string }[];
      for (const m of multi) db.prepare(`INSERT INTO _issues (step, kind, severity, row, col, value, detail) VALUES (?, 'same-name', 'info', NULL, ?, ?, ?)`).run(s.id, s.code, m.label, `${JSON.parse(m.codes).length} codes: ${(JSON.parse(m.codes) as string[]).join(', ')}`);
      ctx.add({ key: s.groupInto.key, label: s.groupInto.label, type: 'text' });
      db.exec(`UPDATE work SET "${s.groupInto.key}" = _cg.label FROM _cg WHERE _cg.code = work.${code}`);
      db.exec(`UPDATE work SET "${s.groupInto.key}" = "${s.into.key}" WHERE "${s.groupInto.key}" IS NULL`);
      r.issues += multi.length;
      r.notes.push(`${fmt(multi.length)} names are used by more than one code (e.g. ${multi.slice(0, 2).map((m) => `${m.label}: ${(JSON.parse(m.codes) as string[]).length} codes`).join('; ') || '—'}); “${s.groupInto.label}” joins them.`);
    }
  },
  classify(ctx, s, r) {
    const c = ctx.col(s.column);
    ctx.add({ key: s.into.key, label: s.into.label, type: 'text' });
    ctx.db.prepare(`UPDATE work SET "${s.into.key}" = gw_classify("${c.key}", ?, ?)`).run(JSON.stringify(s.rules), s.otherwise);
    const counts = ctx.db.prepare(`SELECT "${s.into.key}" v, count(*) n FROM work GROUP BY 1 ORDER BY n DESC`).all() as { v: string; n: number }[];
    r.changed = ctx.count(`"${s.into.key}" IS NOT NULL`);
    r.notes.push(counts.map((x) => `${x.v ?? '(blank)'} ${fmt(Number(x.n))}`).join(' · '));
  },
  duplicates(ctx, s, r) {
    const cs = s.columns.map((k) => `"${ctx.col(k).key}"`);
    const db = ctx.db;
    db.exec('DROP TABLE IF EXISTS temp._dup');
    db.exec(`CREATE TEMP TABLE _dup AS SELECT ${cs.map((c, i) => `${c} k${i}`).join(', ')}, count(*) n, min(_row) first FROM work WHERE ${cs.map((c) => `${c} IS NOT NULL`).join(' AND ')} GROUP BY ${cs.join(', ')} HAVING count(*) > 1`);
    const on = cs.map((c, i) => `w.${c} = d.k${i}`).join(' AND ');
    const groups = Number((db.prepare('SELECT count(*) n FROM _dup').get() as { n: number }).n);
    r.issues = Number(db.prepare(`INSERT INTO _issues (step, kind, severity, row, col, value, detail) SELECT ?, 'duplicate', 'warning', w._row, ?, w.${cs[0]}, 'appears ' || d.n || ' times (first on row ' || d.first || ')' FROM work w JOIN _dup d ON ${on} ORDER BY w._row LIMIT 20000`).run(s.id, s.columns[0]).changes);
    r.examples = (db.prepare(`SELECT w._row _row, w.${cs[0]} b FROM work w JOIN _dup d ON ${on} ORDER BY w._row LIMIT 4`).all() as Record<string, unknown>[]).map((x) => ({ row: Number(x._row), column: s.columns[0], before: x.b as string, note: 'duplicate' }));
    if (s.action === 'drop') {
      db.prepare(`INSERT INTO _removed (step, row, reason) SELECT ?, w._row, 'duplicate' FROM work w JOIN _dup d ON ${on} WHERE w._row <> d.first`).run(s.id);
      r.changed = Number(db.prepare(`DELETE FROM work WHERE _row IN (SELECT w._row FROM work w JOIN _dup d ON ${on} WHERE w._row <> d.first)`).run().changes);
    } else if (s.into) {
      ctx.add({ key: s.into.key, label: s.into.label, type: 'number' });
      r.changed = Number(db.prepare(`UPDATE work SET "${s.into.key}" = d.n FROM _dup d WHERE ${cs.map((c, i) => `work.${c} = d.k${i}`).join(' AND ')}`).run().changes);
    }
    r.notes.push(groups ? `${fmt(groups)} values appear more than once (${fmt(r.issues)} rows)${s.action === 'drop' ? `; ${fmt(r.changed)} later copies removed` : '; flagged, nothing removed'}.` : 'No duplicates.');
  },
  check(ctx, s, r) {
    const c = ctx.col(s.column);
    const k = `"${c.key}"`;
    const params: V[] = [];
    const scope = condSql(ctx, s.where, params);
    let failing: string;
    const fp: V[] = [...params];
    switch (s.kind) {
      case 'unique':
        failing = `${scope} AND ${k} IN (SELECT ${k} FROM work WHERE ${k} IS NOT NULL AND ${scope} GROUP BY ${k} HAVING count(*) > 1)`;
        fp.push(...params);
        break;
      case 'required':
        failing = `${scope} AND ${k} IS NULL`;
        break;
      case 'pattern':
        if (!s.pattern) throw new Error('a pattern check needs a pattern');
        try {
          new RegExp(s.pattern, 'u');
        } catch {
          throw new Error(`the pattern “${s.pattern}” is not a valid regular expression`);
        }
        failing = `${scope} AND ${k} IS NOT NULL AND gw_match(${k}, ?) = 0`;
        fp.push(s.pattern);
        break;
      case 'equal_columns':
        if (!s.other) throw new Error('an equality check needs a second column');
        failing = `${scope} AND ${k} IS NOT ${ctx.q(s.other)}`;
        break;
      case 'positive':
        failing = `${scope} AND ${k} <= 0`;
        break;
      case 'in_list': {
        const vs = s.values ?? [];
        failing = `${scope} AND ${k} IS NOT NULL AND ${k} NOT IN (${vs.map(() => '?').join(',') || 'NULL'})`;
        fp.push(...(vs as V[]));
        break;
      }
    }
    const total = ctx.count(scope, params);
    const n = ctx.count(failing, fp);
    issue(ctx, s.id, `check:${s.kind}`, s.severity, failing, fp, c.key, s.label, 20_000);
    r.examples = (ctx.db.prepare(`SELECT _row, ${k} b FROM work WHERE ${failing} ORDER BY _row LIMIT 4`).all(...fp) as Record<string, unknown>[]).map((x) => ({ row: Number(x._row), column: c.key, before: x.b as string, note: 'fails' }));
    r.issues = n;
    ctx.db.prepare('INSERT INTO _checks (step, label, severity, failing, total) VALUES (?, ?, ?, ?, ?)').run(s.id, s.label, s.severity, n, total);
    r.notes.push(n ? `${fmt(n)} of ${fmt(total)} rows fail (${s.severity}).` : `Passed on all ${fmt(total)} rows.`);
  },
  filter(ctx, s, r) {
    const params: V[] = [];
    const keep = condSql(ctx, s.where, params);
    const drop = `NOT coalesce((${keep}), 0)`;
    ctx.db.prepare(`INSERT INTO _removed (step, row, reason) SELECT ?, _row, 'filtered' FROM work WHERE ${drop}`).run(s.id, ...params);
    r.changed = Number(ctx.db.prepare(`DELETE FROM work WHERE ${drop}`).run(...params).changes);
    r.notes.push(`${fmt(r.changed)} rows left out; ${fmt(ctx.count())} kept.`);
  },
  table(ctx, s, r) {
    const params: V[] = [];
    const where = condSql(ctx, s.where, params);
    const name = `out_${s.key}`;
    ctx.db.exec(`DROP TABLE IF EXISTS "${name}"`);
    let columns: ColumnMeta[];
    if (s.role === 'fact' || (!s.groupBy.length && !s.measures.length)) {
      const keys = s.columns?.length ? s.columns.map((k) => ctx.col(k).key) : ctx.cols.map((c) => c.key);
      ctx.db.prepare(`CREATE TABLE "${name}" AS SELECT _row, ${keys.map((k) => `"${k}"`).join(', ')} FROM work WHERE ${where} ORDER BY _row${s.limit ? ` LIMIT ${s.limit}` : ''}`).run(...params);
      columns = keys.map((k) => ({ ...ctx.col(k) }));
    } else {
      const taken = new Set<string>();
      const sel: string[] = [];
      const mp: V[] = [];
      columns = [];
      for (const g of s.groupBy) {
        const c = ctx.col(g.column);
        const key = slug(g.label ?? c.label, taken);
        sel.push(`"${c.key}" AS "${key}"`);
        columns.push({ ...c, key, label: g.label ?? c.label });
      }
      for (const m of s.measures) {
        const c = m.column ? ctx.col(m.column) : undefined;
        if (m.fn !== 'count' && !c) throw new Error(`the measure “${m.label}” needs a column`);
        const key = slug(m.label, taken);
        const w = m.where?.length ? condSql(ctx, m.where, mp) : null;
        const col = c ? `"${c.key}"` : '1';
        const v = w ? `CASE WHEN ${w} THEN ${col} END` : col;
        let expr: string;
        let meta: ColumnMeta = { key, label: m.label, type: 'number' };
        switch (m.fn) {
          case 'count':
            expr = w ? `count(${v})` : c ? `count(${col})` : 'count(*)';
            break;
          case 'sum':
            expr = `round(total(${v}), 2)`;
            meta = { ...meta, unit: c?.unit };
            break;
          case 'avg':
            expr = `round(avg(${v}), 2)`;
            meta = { ...meta, unit: c?.unit };
            break;
          case 'min':
          case 'max':
          case 'first':
            expr = `${m.fn === 'max' ? 'max' : 'min'}(${v})`;
            meta = { ...meta, type: c!.type, unit: c!.unit };
            break;
          case 'count_distinct':
            expr = `count(DISTINCT ${v})`;
            break;
          case 'share': {
            const tp: V[] = [...params];
            const tw = w ? `${where} AND ${condSql(ctx, m.where, tp)}` : where;
            const tot = Number((ctx.db.prepare(`SELECT total(${col}) t FROM work WHERE ${tw}`).get(...tp) as { t: number }).t);
            expr = tot ? `round(total(${v}) / ${tot}, 4)` : 'NULL';
            meta = { ...meta, unit: '%' };
            break;
          }
        }
        sel.push(`${expr} AS "${key}"`);
        columns.push(meta);
      }
      const groups = s.groupBy.map((_, i) => String(i + 1));
      const resolve = (by: string) => columns.find((c) => c.key === by || c.label.toLowerCase() === by.toLowerCase())?.key;
      let order = (s.orderBy ?? []).map((o) => (resolve(o.by) ? `"${resolve(o.by)}"${o.desc ? ' DESC' : ''}` : null)).filter(Boolean) as string[];
      if (!order.length && columns.length) {
        const first = columns[0];
        const firstMeasure = columns[s.groupBy.length];
        order = s.groupBy.length && (first.type === 'date' || /month|m[eê]s|quarter|year|ano|period/i.test(first.key)) ? [`"${first.key}"`] : firstMeasure ? [`"${firstMeasure.key}" DESC`] : [];
      }
      ctx.db.prepare(`CREATE TABLE "${name}" AS SELECT ${sel.join(', ')} FROM work WHERE ${where}${groups.length ? ` GROUP BY ${groups.join(', ')}` : ''}${order.length ? ` ORDER BY ${order.join(', ')}` : ''}${s.limit ? ` LIMIT ${s.limit}` : ''}`).run(...mp, ...params);
    }
    const rows = Number((ctx.db.prepare(`SELECT count(*) n FROM "${name}"`).get() as { n: number }).n);
    r.output = { key: s.key, label: s.label, role: s.role, rows, columns, place: s.place, step: s.id };
    r.rowsOut = rows;
    r.notes.push(`${fmt(rows)} rows × ${columns.length} columns.`);
  },
  pivot(ctx, s, r) {
    const params: V[] = [];
    const where = condSql(ctx, s.where, params);
    const R = ctx.col(s.rows);
    const C = ctx.col(s.columns);
    const val = s.value ? ctx.col(s.value) : undefined;
    const vals = (ctx.db.prepare(`SELECT DISTINCT "${C.key}" v FROM work WHERE "${C.key}" IS NOT NULL AND ${where} ORDER BY 1 LIMIT 25`).all(...params) as { v: string }[]).map((x) => x.v);
    if (vals.length > 24) throw new Error(`“${C.label}” has more than 24 values: too many columns for a pivot`);
    const taken = new Set<string>([slug(R.label, new Set())]);
    const rk = [...taken][0];
    const pp: V[] = [];
    const cols: ColumnMeta[] = [{ ...R, key: rk }];
    const sel = [`"${R.key}" AS "${rk}"`];
    for (const v of vals) {
      const key = slug(String(v), taken);
      pp.push(v);
      sel.push(s.fn === 'count' || !val ? `total(CASE WHEN "${C.key}" = ? THEN 1 ELSE 0 END) AS "${key}"` : `round(total(CASE WHEN "${C.key}" = ? THEN "${val.key}" END), 2) AS "${key}"`);
      cols.push({ key, label: String(v), type: 'number', unit: s.fn === 'count' || !val ? undefined : val.unit });
    }
    const tk = slug('Total', taken);
    sel.push(s.fn === 'count' || !val ? `count(*) AS "${tk}"` : `round(total("${val.key}"), 2) AS "${tk}"`);
    cols.push({ key: tk, label: 'Total', type: 'number', unit: s.fn === 'count' || !val ? undefined : val.unit });
    const name = `out_${s.key}`;
    ctx.db.exec(`DROP TABLE IF EXISTS "${name}"`);
    ctx.db.prepare(`CREATE TABLE "${name}" AS SELECT ${sel.join(', ')} FROM work WHERE ${where} GROUP BY 1 ORDER BY 1`).run(...pp, ...params);
    const rows = Number((ctx.db.prepare(`SELECT count(*) n FROM "${name}"`).get() as { n: number }).n);
    r.output = { key: s.key, label: s.label, role: 'analysis', rows, columns: cols, place: s.place, step: s.id };
    r.rowsOut = rows;
    r.notes.push(`${fmt(rows)} rows × ${vals.length} ${C.label} columns.`);
  },
  ageing(ctx, s, r) {
    const params: V[] = [];
    const where = condSql(ctx, s.where, params);
    const D = ctx.col(s.date);
    const A = ctx.col(s.amount);
    let asOf = s.asOf;
    if (asOf === 'max') asOf = String((ctx.db.prepare(`SELECT max("${D.key}") m FROM work`).get() as { m: string }).m ?? '');
    const b = [...new Set(s.buckets)].sort((x, y) => x - y);
    const labels = b.map((x, i) => `${i ? b[i - 1] + 1 : 0}–${x} days`).concat(`Over ${b[b.length - 1]} days`);
    const conds = b.map((x, i) => (i ? `age > ${b[i - 1]} AND age <= ${x}` : `age <= ${x}`)).concat(`age > ${b[b.length - 1]}`);
    const inner = `SELECT ${s.per ? `${ctx.q(s.per)} AS by_key, ` : ''}"${A.key}" amt, "${D.key}" dt, CAST(julianday(?) - julianday("${D.key}") AS INTEGER) age FROM work WHERE "${D.key}" IS NOT NULL AND ${where}`;
    const name = `out_${s.key}`;
    ctx.db.exec(`DROP TABLE IF EXISTS "${name}"`);
    const taken = new Set<string>();
    let cols: ColumnMeta[];
    if (s.per) {
      const B = ctx.col(s.per);
      const bk = slug(B.label, taken);
      const keys = labels.map((l) => slug(l, taken));
      const tk = slug('Total', taken);
      const dk = slug('Documents', taken);
      const ok = slug('Oldest', taken);
      ctx.db.prepare(`CREATE TABLE "${name}" AS SELECT by_key AS "${bk}", ${conds.map((c, i) => `round(total(CASE WHEN ${c} THEN amt END), 2) AS "${keys[i]}"`).join(', ')}, round(total(amt), 2) AS "${tk}", count(*) AS "${dk}", min(dt) AS "${ok}" FROM (${inner}) GROUP BY 1 ORDER BY "${tk}" DESC${s.limit ? ` LIMIT ${s.limit}` : ''}`).run(asOf, ...params);
      cols = [{ ...B, key: bk }, ...labels.map((l, i) => ({ key: keys[i], label: l, type: 'number' as const, unit: A.unit })), { key: tk, label: 'Total', type: 'number', unit: A.unit }, { key: dk, label: 'Documents', type: 'number' }, { key: ok, label: 'Oldest', type: 'date' }];
    } else {
      const agg = ctx.db.prepare(`SELECT ${conds.map((c, i) => `total(CASE WHEN ${c} THEN amt END) a${i}, total(CASE WHEN ${c} THEN 1 END) n${i}`).join(', ')}, total(amt) t FROM (${inner})`).get(asOf, ...params) as Record<string, number>;
      ctx.db.exec(`CREATE TABLE "${name}" (age_band, documents, amount, share)`);
      const ins = ctx.db.prepare(`INSERT INTO "${name}" VALUES (?, ?, ?, ?)`);
      labels.forEach((l, i) => ins.run(l, Number(agg[`n${i}`]), Math.round(Number(agg[`a${i}`]) * 100) / 100, Number(agg.t) ? Math.round((Number(agg[`a${i}`]) / Number(agg.t)) * 10000) / 10000 : null));
      cols = [{ key: 'age_band', label: 'Age', type: 'text' }, { key: 'documents', label: 'Documents', type: 'number' }, { key: 'amount', label: 'Amount', type: 'number', unit: A.unit }, { key: 'share', label: 'Share', type: 'number', unit: '%' }];
    }
    const rows = Number((ctx.db.prepare(`SELECT count(*) n FROM "${name}"`).get() as { n: number }).n);
    r.output = { key: s.key, label: s.label, role: 'analysis', rows, columns: cols, place: s.place, step: s.id };
    r.rowsOut = rows;
    r.notes.push(`Age of ${D.label} at ${asOf}; ${fmt(rows)} rows.`);
  },
  exceptions(ctx, s, r) {
    const name = `out_${s.key}`;
    ctx.db.exec(`DROP TABLE IF EXISTS "${name}"`);
    ctx.db.exec(`CREATE TABLE "${name}" (check_name, severity, column_name, rows_affected, first_rows, example, detail)`);
    const groups = ctx.db.prepare(`SELECT step, kind, severity, col, count(*) n, min(detail) detail, min(value) example, (SELECT group_concat(row, ', ') FROM (SELECT row FROM _issues j WHERE j.step = i.step AND j.kind = i.kind AND j.col IS i.col AND row IS NOT NULL ORDER BY row LIMIT 5)) rows FROM _issues i GROUP BY step, kind, severity, col ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, n DESC`).all() as Record<string, string | number | null>[];
    const ins = ctx.db.prepare(`INSERT INTO "${name}" VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const kindLabel = (k: string, d: string | null) => (k === 'rejected' ? `Could not be read (${d})` : k === 'duplicate' ? 'Duplicate' : k === 'name-variants' ? 'Code written with several names' : k === 'same-name' ? 'Name used by several codes' : (d ?? k.replace('check:', '')));
    for (const g of groups) ins.run(kindLabel(String(g.kind), g.detail as string | null), g.severity, ctx.label(String(g.col ?? '')), g.n, g.rows ?? '', g.example === null ? null : String(g.example).slice(0, 200), g.kind === 'rejected' || String(g.kind).startsWith('check:') ? null : g.detail);
    const rows = groups.length;
    const cols: ColumnMeta[] = [
      { key: 'check_name', label: 'Check', type: 'text' },
      { key: 'severity', label: 'Severity', type: 'text' },
      { key: 'column_name', label: 'Column', type: 'text' },
      { key: 'rows_affected', label: 'Rows / items', type: 'number' },
      { key: 'first_rows', label: 'First rows in the file', type: 'text' },
      { key: 'example', label: 'Example', type: 'text' },
      { key: 'detail', label: 'Detail', type: 'text' },
    ];
    r.output = { key: s.key, label: s.label, role: 'exceptions', rows, columns: cols, place: s.place, step: s.id };
    r.rowsOut = rows;
    r.notes.push(rows ? `${fmt(rows)} kinds of exception listed.` : 'No exceptions.');
  },
};

function previewOf(db: DatabaseSync, table: string, columns: ColumnMeta[], n: number, withRow: boolean): Preview {
  const keys = [...(withRow ? ['_row'] : []), ...columns.map((c) => c.key)];
  const st = db.prepare(`SELECT ${keys.map((k) => `"${k}"`).join(', ')} FROM "${table}" LIMIT ${n}`);
  st.setReturnArrays(true);
  return { columns: withRow ? [{ key: '_row', label: 'Row in file', type: 'number' }, ...columns] : columns, rows: st.all() as unknown as unknown[][], total: Number((db.prepare(`SELECT count(*) n FROM "${table}"`).get() as { n: number }).n) };
}

/** Run every enabled step in order; stop at the first failure. `db` has the raw data attached as `src`. */
export function runSteps(db: DatabaseSync, list: Step[], sheets: SheetMeta[], opts: { sample?: number; preview?: number; onStep?: (i: number, of: number, id: string) => void } = {}): RunOutput {
  const t0 = Date.now();
  db.exec(`DROP TABLE IF EXISTS _issues; DROP TABLE IF EXISTS _removed; DROP TABLE IF EXISTS _checks; DROP TABLE IF EXISTS _steps;
    CREATE TABLE _issues (step TEXT, kind TEXT, severity TEXT, row INTEGER, col TEXT, value, detail TEXT);
    CREATE TABLE _removed (step TEXT, row INTEGER, reason TEXT);
    CREATE TABLE _checks (step TEXT, label TEXT, severity TEXT, failing INTEGER, total INTEGER);
    CREATE TABLE _steps (seq INTEGER, id TEXT, type TEXT, step TEXT, result TEXT);`);
  for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'out\\_%' ESCAPE '\\'`).all() as { name: string }[]) db.exec(`DROP TABLE "${t.name}"`);
  const ctx = new Ctx(db, sheets, opts.sample);
  const results: StepResult[] = [];
  let failedAt: string | undefined;
  const first = list.find((s) => s.enabled !== false);
  if (!first || first.type !== 'header') throw new Error('a recipe starts by reading the sheet and its header');
  const save = db.prepare('INSERT INTO _steps (seq, id, type, step, result) VALUES (?, ?, ?, ?, ?)');
  list.forEach((s, i) => {
    const r: StepResult = { id: s.id, type: s.type, status: 'done', rowsIn: 0, rowsOut: 0, changed: 0, rejected: 0, issues: 0, examples: [], notes: [], ms: 0 };
    if (failedAt) r.status = 'blocked';
    else if (s.enabled === false) r.status = 'skipped';
    else {
      opts.onStep?.(i, list.length, s.id);
      const t = Date.now();
      r.rowsIn = s.type === 'header' ? 0 : ctx.count();
      db.exec('BEGIN');
      try {
        (steps[s.type] as Exec)(ctx, s, r);
        db.exec('COMMIT');
        if (s.type !== 'header' && !r.output) r.rowsOut = ctx.count();
        if (r.output) r.rowsIn = ctx.count();
      } catch (e) {
        db.exec('ROLLBACK');
        r.status = 'failed';
        r.error = (e as Error).message;
        failedAt = s.id;
      }
      r.ms = Date.now() - t;
    }
    save.run(i, s.id, s.type, JSON.stringify({ ...s, text: describe(s, ctx.label) }), JSON.stringify(r));
    results.push(r);
  });
  const outputs = results.filter((r) => r.output).map((r) => r.output!);
  const checks = db.prepare('SELECT step, label, severity, failing, total FROM _checks').all() as unknown as CheckResult[];
  const out: RunOutput = { ok: !failedAt, failedAt, results, columns: ctx.cols, rows: db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work'`).get() ? ctx.count() : 0, outputs, checks, unit: ctx.unit, sample: opts.sample, ms: Date.now() - t0 };
  if (opts.preview) {
    out.preview = { work: previewOf(db, 'work', ctx.cols, opts.preview, true), outputs: {} };
    for (const o of outputs) out.preview.outputs[o.key] = previewOf(db, `out_${o.key}`, o.columns, opts.preview, false);
  }
  return out;
}

/** Rows of a table in a finished run (work, out_<key>, or the audit tables), a page at a time. */
export function pageOf(db: DatabaseSync, table: string, offset: number, limit: number, keys?: string[]): { columns: string[]; rows: unknown[][]; total: number } {
  if (!/^(work|out_[a-z][a-z0-9_]{0,62}|_issues|_removed|_checks)$/.test(table)) throw new Error('no such table');
  const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!exists) throw new Error('no such table in this run');
  const cols = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name).filter((c) => !keys || keys.includes(c) || c === '_row');
  const st = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}" LIMIT ? OFFSET ?`);
  st.setReturnArrays(true);
  return { columns: cols, rows: st.all(limit, offset) as unknown as unknown[][], total: Number((db.prepare(`SELECT count(*) n FROM "${table}"`).get() as { n: number }).n) };
}
