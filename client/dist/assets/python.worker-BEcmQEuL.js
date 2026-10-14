(function(){"use strict";function j(n){let o=0;for(const a of n.toUpperCase())o=o*26+(a.charCodeAt(0)-64);return o-1}function q(n){let o,a=n.trim();const f=a.lastIndexOf("::");f>=0&&(o=a.slice(0,f).trim().replace(/^'(.*)'$/,"$1"),a=a.slice(f+2).trim());const l=a.match(/^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/);if(!l)return null;const u=j(l[1]),c=parseInt(l[2],10)-1,d=l[3]?j(l[3]):u,r=l[4]?parseInt(l[4],10)-1:c;return{table:o,r0:Math.min(c,r),c0:Math.min(u,d),r1:Math.max(c,r),c1:Math.max(u,d)}}class m extends Error{}function N(n){const o=[],a=new Map(n.tables.map(r=>[r.name.trim().toLowerCase(),r])),f=new Map(n.tables.map(r=>[r.id,r]));function l(r){if(r===void 0){const t=f.get(n.current.table);if(!t)throw new m("current table not found");return t}const e=a.get(r.trim().toLowerCase());if(!e)throw new m(`table "${r}" not found (tables: ${n.tables.map(t=>t.name).join(", ")})`);return e}function u(r){var x;const e=q(r);if(!e)throw new m(`bad reference "${r}" — use A1, A1:B5 or "Table 2::A1:B5"`);const t=l(e.table),i=Math.min(e.r1,t.rows-1),p=Math.min(e.c1,t.cols-1);if(e.r0>=t.rows||e.c0>=t.cols)throw new m(`reference "${r}" is outside table "${t.name}" (${t.rows}×${t.cols})`);const _=[];for(let w=e.r0;w<=i;w++){const k=[];for(let h=e.c0;h<=p;h++)k.push(((x=t.values[w])==null?void 0:x[h])??null);_.push(k)}return o.push({table:t.id,r0:e.r0,c0:e.c0,r1:i,c1:p}),{values:_,rect:{table:t.id,r0:e.r0,c0:e.c0,r1:i,c1:p},rows:i-e.r0+1,cols:p-e.c0+1}}function c(r){const e=l(r);return o.push({table:e.id,r0:0,c0:0,r1:e.rows-1,c1:e.cols-1}),{values:e.values,rect:{table:e.id,r0:0,c0:0,r1:e.rows-1,c1:e.cols-1},rows:e.rows,cols:e.cols}}return{cells(r){const e=u(r);return e.rows===1&&e.cols===1?e.values[0][0]:e.cols===1?e.values.map(t=>t[0]):e.rows===1?e.values[0]:e.values},table(r){return c(r).values},records(r){const e=c(r).values;if(!e.length)return[];const t=e[0].map((i,p)=>i===null||i===""?`col${p+1}`:String(i));return e.slice(1).map(i=>Object.fromEntries(t.map((p,_)=>[p,i[_]??null])))},names(){return n.tables.map(r=>r.name)},pos(){return{...n.current}},_raw:u,_table:c,deps:o}}let s=null,b=null,g="https://cdn.jsdelivr.net/pyodide/v0.27.5/full/";const F=`
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

def _q_figure_png(obj):
    """matplotlib Figure/Axes → (data URL, width px, height px), else None."""
    try:
        import matplotlib
        from matplotlib.figure import Figure
        fig = None
        if isinstance(obj, Figure):
            fig = obj
        elif hasattr(obj, "figure") and isinstance(getattr(obj, "figure"), Figure):
            fig = obj.figure
        elif hasattr(obj, "get_figure"):
            f = obj.get_figure()
            if isinstance(f, Figure):
                fig = f
        if fig is None:
            return None
        import io, base64
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=96, bbox_inches="tight", facecolor="white")
        w, h = fig.get_size_inches()
        data = base64.b64encode(buf.getvalue()).decode("ascii")
        try:
            import matplotlib.pyplot as plt
            plt.close(fig)
        except Exception:
            pass
        return ("data:image/png;base64," + data, int(w * 96), int(h * 96))
    except Exception:
        return None

def _q_convert(obj):
    """Turn a cell result into a JSON 2-D list (or None, or {"image":...})."""
    if obj is None:
        return json.dumps(None)
    png = _q_figure_png(obj)
    if png is not None:
        return json.dumps({"image": png[0], "width": png[1], "height": png[2]})
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
`;async function v(){s||(b||(b=(async()=>{s=await(await import(g+"pyodide.mjs")).loadPyodide({indexURL:g}),await s.runPythonAsync(F),self.postMessage({type:"ready"})})()),await b)}self.onmessage=async n=>{var r;const o=n.data;if(o.type==="init"){g=o.indexURL||g;try{await v()}catch(e){self.postMessage({type:"init-error",error:String(e)})}return}const{id:a,code:f,snapshot:l}=o,u=[],c=[];try{await v()}catch(e){self.postMessage({id:a,ok:!1,error:`Python runtime failed to load: ${String(e)}`,std_out:"",deps:[]}),b=null;return}const d=N(l);s.globals.set("_q_cells",e=>JSON.stringify(d._raw(e))),s.globals.set("_q_table",e=>JSON.stringify(d._table(e??void 0))),s.globals.set("_q_names",()=>JSON.stringify(d.names())),s.globals.set("_q_pos",()=>JSON.stringify(d.pos())),s.setStdout({batched:e=>u.push(e)}),s.setStderr({batched:e=>c.push(e)});try{await s.loadPackagesFromImports(f);const e=await s.runPythonAsync(f),t=s.globals.get("_q_convert"),i=t(e);(r=t.destroy)==null||r.call(t),e&&typeof e.destroy=="function"&&e.destroy(),self.postMessage({id:a,code:f,ok:!0,output:JSON.parse(i),std_out:u.join(`
`),deps:d.deps,runtime:y()})}catch(e){let t=String(e);const i=t.lastIndexOf('File "<exec>"');i>=0&&(t=t.slice(i)),c.length&&(t=c.join(`
`)+`
`+t),self.postMessage({id:a,code:f,ok:!1,error:t,std_out:u.join(`
`),deps:d.deps,runtime:y()})}};function y(){const n={};try{const o=(s==null?void 0:s.loadedPackages)??{};for(const a of Object.keys(o))n[a]=String(o[a])}catch{}return{name:"pyodide",version:String((s==null?void 0:s.version)??""),packages:n}}})();
