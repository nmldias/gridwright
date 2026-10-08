// Python code cells run in Pyodide inside this module worker. The runtime is
// loaded as an ES module from `indexURL` (CDN by default, or a self-hosted copy).
/// <reference lib="webworker" />

import { makeQ, type Snapshot } from './q';

interface InitMsg {
  type: 'init';
  indexURL: string;
}
interface RunMsg {
  type: 'run';
  id: number;
  code: string;
  snapshot: Snapshot;
}

let pyodide: any = null;
let loading: Promise<void> | null = null;
let indexURL = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/';

const PRELUDE = `
import json, sys
class _Q:
    """Data access for the current workbook."""
    def cells(self, ref, first_row_header=False):
        raw = json.loads(_q_cells(ref))
        vals = raw["values"]
        rows = raw["rows"]; cols = raw["cols"]
        if rows == 1 and cols == 1:
            return vals[0][0]
        if "pandas" in sys.modules:
            import pandas as pd
            if first_row_header and rows > 1:
                return pd.DataFrame(vals[1:], columns=[str(h) if h is not None else f"col{i+1}" for i, h in enumerate(vals[0])])
            if cols == 1:
                return pd.Series([r[0] for r in vals])
            return pd.DataFrame(vals)
        if cols == 1:
            return [r[0] for r in vals]
        if rows == 1:
            return vals[0]
        return vals
    def df(self, ref, first_row_header=True):
        import pandas as pd
        raw = json.loads(_q_cells(ref))
        vals = raw["values"]
        if first_row_header and len(vals) > 1:
            return pd.DataFrame(vals[1:], columns=[str(h) if h is not None else f"col{i+1}" for i, h in enumerate(vals[0])])
        return pd.DataFrame(vals)
    def table(self, name=None, first_row_header=True):
        raw = json.loads(_q_table(name))
        vals = raw["values"]
        if "pandas" in sys.modules:
            import pandas as pd
            if first_row_header and len(vals) > 1:
                return pd.DataFrame(vals[1:], columns=[str(h) if h is not None else f"col{i+1}" for i, h in enumerate(vals[0])])
            return pd.DataFrame(vals)
        return vals
    def names(self):
        return json.loads(_q_names())
    def pos(self):
        return json.loads(_q_pos())
q = _Q()

def _q_plain(x):
    import datetime, decimal, math
    if x is None: return None
    if isinstance(x, bool): return x
    if isinstance(x, (int, float)):
        if isinstance(x, float) and (math.isnan(x) or math.isinf(x)): return None
        return x
    if isinstance(x, str): return x
    if isinstance(x, decimal.Decimal): return float(x)
    if isinstance(x, (datetime.date, datetime.datetime)): return x.isoformat()
    try:
        import numpy as np
        if isinstance(x, np.generic):
            v = x.item()
            return _q_plain(v)
    except Exception:
        pass
    return str(x)

def _q_convert(obj):
    """Turn a cell result into a JSON 2-D list (or None)."""
    if obj is None:
        return json.dumps(None)
    try:
        import pandas as pd
        if isinstance(obj, pd.DataFrame):
            header = [str(c) for c in obj.columns]
            rows = [[_q_plain(v) for v in row] for row in obj.itertuples(index=False, name=None)]
            return json.dumps([header] + rows)
        if isinstance(obj, pd.Series):
            return json.dumps([[_q_plain(v)] for v in obj.tolist()])
    except Exception:
        pass
    try:
        import numpy as np
        if isinstance(obj, np.ndarray):
            obj = obj.tolist()
    except Exception:
        pass
    if isinstance(obj, dict):
        return json.dumps([[str(k), _q_plain(v)] for k, v in obj.items()])
    if isinstance(obj, (list, tuple)):
        if len(obj) == 0:
            return json.dumps([[None]])
        if all(isinstance(r, (list, tuple)) for r in obj):
            return json.dumps([[_q_plain(v) for v in r] for r in obj])
        if all(isinstance(r, dict) for r in obj):
            keys = []
            for r in obj:
                for k in r.keys():
                    if k not in keys: keys.append(k)
            return json.dumps([[str(k) for k in keys]] + [[_q_plain(r.get(k)) for k in keys] for r in obj])
        return json.dumps([[_q_plain(v)] for v in obj])
    return json.dumps([[_q_plain(obj)]])
`;

async function ensure(): Promise<void> {
  if (pyodide) return;
  if (!loading) {
    loading = (async () => {
      const mod = await import(/* @vite-ignore */ indexURL + 'pyodide.mjs');
      pyodide = await mod.loadPyodide({ indexURL });
      await pyodide.runPythonAsync(PRELUDE);
      self.postMessage({ type: 'ready' });
    })();
  }
  await loading;
}

self.onmessage = async (e: MessageEvent<InitMsg | RunMsg>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    indexURL = msg.indexURL || indexURL;
    try {
      await ensure();
    } catch (err) {
      self.postMessage({ type: 'init-error', error: String(err) });
    }
    return;
  }
  const { id, code, snapshot } = msg;
  const out: string[] = [];
  const errOut: string[] = [];
  try {
    await ensure();
  } catch (err) {
    self.postMessage({ id, ok: false, error: `Python runtime failed to load: ${String(err)}`, std_out: '', deps: [] });
    loading = null;
    return;
  }
  const q = makeQ(snapshot);
  pyodide.globals.set('_q_cells', (ref: string) => JSON.stringify(q._raw(ref)));
  pyodide.globals.set('_q_table', (name: string | null | undefined) => JSON.stringify(q._table(name ?? undefined)));
  pyodide.globals.set('_q_names', () => JSON.stringify(q.names()));
  pyodide.globals.set('_q_pos', () => JSON.stringify(q.pos()));
  pyodide.setStdout({ batched: (s: string) => out.push(s) });
  pyodide.setStderr({ batched: (s: string) => errOut.push(s) });
  try {
    await pyodide.loadPackagesFromImports(code);
    const result = await pyodide.runPythonAsync(code);
    const convert = pyodide.globals.get('_q_convert');
    const json: string = convert(result);
    convert.destroy?.();
    if (result && typeof result.destroy === 'function') result.destroy();
    self.postMessage({ id, ok: true, output: JSON.parse(json), std_out: out.join('\n'), deps: q.deps });
  } catch (err) {
    let msg = String(err);
    // keep only the useful tail of Pyodide tracebacks
    const idx = msg.lastIndexOf('File "<exec>"');
    if (idx >= 0) msg = msg.slice(idx);
    if (errOut.length) msg = errOut.join('\n') + '\n' + msg;
    self.postMessage({ id, ok: false, error: msg, std_out: out.join('\n'), deps: q.deps });
  }
};
