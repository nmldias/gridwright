"""Gridwright server-side Python cell runner.

One run per process. Reads a JSON request on stdin:
  {"code": "...", "snapshot": {"tables": [...], "current": {...}}, "gpu": false,
   "limits": {"memoryMb": 2048, "cpuSeconds": 60, "maxCells": 200000, "fileMb": 64}}
and writes, after a marker line, a JSON result on stdout:
  {"ok": true, "output": [[...]] | {"image": ...} | null, "std_out": "...", "deps": [...], "runtime": {...}}
  {"ok": false, "error": "...", "std_out": "...", "deps": [...], "runtime": {...}}

The `q` object and the output conversion mirror the browser (Pyodide) runtime exactly, so a cell
gives the same result wherever it runs. The process is expected to be wrapped in a sandbox by the
server (bubblewrap / user namespace); the resource limits below hold either way.
"""
import ast
import io
import json
import os
import re
import signal
import sys
import time
import traceback

MARKER = "\n__GRIDWRIGHT_RESULT__\n"


def set_limits(limits, gpu):
    try:
        import resource

        cpu = int(limits.get("cpuSeconds") or 60)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))

        def over_cpu(_sig, _frame):
            raise TimeoutError("CPU time limit of %d s exceeded" % cpu)

        signal.signal(signal.SIGXCPU, over_cpu)
        fsz = int(limits.get("fileMb") or 64) * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsz, fsz))
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        except Exception:
            pass
        # Memory: cap the data segment (heap + private anonymous mappings), not the whole address
        # space — shared libraries, thread stacks and the per-core BLAS buffers numpy reserves at
        # import would otherwise eat the budget on machines with many cores. CUDA reserves huge
        # address ranges of its own, so GPU runs are not capped here (the wall-clock limit still holds).
        if not gpu:
            mem = int(limits.get("memoryMb") or 2048) * 1024 * 1024
            try:
                resource.setrlimit(resource.RLIMIT_DATA, (mem, mem))
            except Exception:
                resource.setrlimit(resource.RLIMIT_AS, (mem * 2, mem * 2))
    except Exception:
        pass


# ---------------------------------------------------------------------------------------------
# q: the same data-access object as the browser worker (client/src/workers/q.ts)
# ---------------------------------------------------------------------------------------------
A1 = re.compile(r"^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$")


def letters_to_col(s):
    n = 0
    for ch in s.upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def parse_a1(ref):
    table = None
    body = ref.strip()
    dc = body.rfind("::")
    if dc >= 0:
        table = body[:dc].strip()
        if len(table) >= 2 and table[0] == "'" and table[-1] == "'":
            table = table[1:-1]
        body = body[dc + 2 :].strip()
    m = A1.match(body)
    if not m:
        return None
    c0 = letters_to_col(m.group(1))
    r0 = int(m.group(2)) - 1
    c1 = letters_to_col(m.group(3)) if m.group(3) else c0
    r1 = int(m.group(4)) - 1 if m.group(4) else r0
    return {"table": table, "r0": min(r0, r1), "c0": min(c0, c1), "r1": max(r0, r1), "c1": max(c0, c1)}


class QError(Exception):
    pass


class _Q:
    """Data access for the current workbook (snapshot taken right before the run)."""

    def __init__(self, snapshot):
        self._snap = snapshot
        self._by_name = {t["name"].strip().lower(): t for t in snapshot["tables"]}
        self._by_id = {t["id"]: t for t in snapshot["tables"]}
        self.deps = []

    def _table_for(self, name=None):
        if name is None:
            t = self._by_id.get(self._snap["current"]["table"])
            if not t:
                raise QError("current table not found")
            return t
        t = self._by_name.get(str(name).strip().lower())
        if not t:
            raise QError('table "%s" not found (tables: %s)' % (name, ", ".join(x["name"] for x in self._snap["tables"])))
        return t

    def _raw(self, ref):
        p = parse_a1(str(ref))
        if not p:
            raise QError('bad reference "%s" — use A1, A1:B5 or "Table 2::A1:B5"' % ref)
        t = self._table_for(p["table"])
        r1 = min(p["r1"], t["rows"] - 1)
        c1 = min(p["c1"], t["cols"] - 1)
        if p["r0"] >= t["rows"] or p["c0"] >= t["cols"]:
            raise QError('reference "%s" is outside table "%s" (%d×%d)' % (ref, t["name"], t["rows"], t["cols"]))
        vals = []
        for r in range(p["r0"], r1 + 1):
            row = t["values"][r] if r < len(t["values"]) else []
            vals.append([row[c] if c < len(row) else None for c in range(p["c0"], c1 + 1)])
        self.deps.append({"table": t["id"], "r0": p["r0"], "c0": p["c0"], "r1": r1, "c1": c1})
        return {"values": vals, "rows": r1 - p["r0"] + 1, "cols": c1 - p["c0"] + 1}

    def _table(self, name=None):
        t = self._table_for(name)
        self.deps.append({"table": t["id"], "r0": 0, "c0": 0, "r1": t["rows"] - 1, "c1": t["cols"] - 1})
        return {"values": t["values"], "rows": t["rows"], "cols": t["cols"]}

    @staticmethod
    def _frame(vals, first_row_header):
        import pandas as pd

        if first_row_header and len(vals) > 1:
            return pd.DataFrame(vals[1:], columns=[str(h) if h is not None else "col%d" % (i + 1) for i, h in enumerate(vals[0])])
        return pd.DataFrame(vals)

    def cells(self, ref, first_row_header=False):
        raw = self._raw(ref)
        vals, rows, cols = raw["values"], raw["rows"], raw["cols"]
        if rows == 1 and cols == 1:
            return vals[0][0]
        if "pandas" in sys.modules:
            import pandas as pd

            if first_row_header and rows > 1:
                return self._frame(vals, True)
            if cols == 1:
                return pd.Series([r[0] for r in vals])
            return pd.DataFrame(vals)
        if cols == 1:
            return [r[0] for r in vals]
        if rows == 1:
            return vals[0]
        return vals

    def df(self, ref, first_row_header=True):
        return self._frame(self._raw(ref)["values"], first_row_header)

    def table(self, name=None, first_row_header=True):
        vals = self._table(name)["values"]
        if "pandas" in sys.modules:
            return self._frame(vals, first_row_header)
        return vals

    def records(self, name=None):
        v = self._table(name)["values"]
        if not v:
            return []
        header = ["col%d" % (i + 1) if h is None or h == "" else str(h) for i, h in enumerate(v[0])]
        return [{h: (row[i] if i < len(row) else None) for i, h in enumerate(header)} for row in v[1:]]

    def names(self):
        return [t["name"] for t in self._snap["tables"]]

    def pos(self):
        return dict(self._snap["current"])


# ---------------------------------------------------------------------------------------------
# result conversion (identical rules to the browser prelude)
# ---------------------------------------------------------------------------------------------
def _plain(x):
    import datetime
    import decimal
    import math

    if x is None:
        return None
    if isinstance(x, bool):
        return x
    if isinstance(x, (int, float)):
        if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
            return None
        return x
    if isinstance(x, str):
        return x
    if isinstance(x, decimal.Decimal):
        return float(x)
    if isinstance(x, (datetime.date, datetime.datetime)):
        return x.isoformat()
    try:
        import numpy as np

        if isinstance(x, np.generic):
            return _plain(x.item())
    except Exception:
        pass
    try:
        import pandas as pd

        if x is pd.NaT or (hasattr(pd, "isna") and not isinstance(x, (list, dict, tuple)) and pd.isna(x) is True):
            return None
        if isinstance(x, pd.Timestamp):
            return x.isoformat()
    except Exception:
        pass
    return str(x)


def _figure_png(obj):
    try:
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
        import base64

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


def convert(obj, max_cells):
    """Cell result → 2-D list, {"image": ...} or None; plus a truncation note."""
    if obj is None:
        return None, None
    png = _figure_png(obj)
    if png is not None:
        return {"image": png[0], "width": png[1], "height": png[2]}, None
    grid = None
    try:
        import pandas as pd

        if hasattr(obj, "to_pandas"):  # cudf
            obj = obj.to_pandas()
        if isinstance(obj, pd.DataFrame):
            header = [str(c) for c in obj.columns]
            grid = [header] + [[_plain(v) for v in row] for row in obj.itertuples(index=False, name=None)]
        elif isinstance(obj, pd.Series):
            grid = [[_plain(v)] for v in obj.tolist()]
    except Exception:
        pass
    if grid is None:
        try:
            import numpy as np

            if isinstance(obj, np.ndarray):
                obj = obj.tolist()
        except Exception:
            pass
        if isinstance(obj, dict):
            grid = [[str(k), _plain(v)] for k, v in obj.items()]
        elif isinstance(obj, (list, tuple)):
            if len(obj) == 0:
                grid = [[None]]
            elif all(isinstance(r, (list, tuple)) for r in obj):
                grid = [[_plain(v) for v in r] for r in obj]
            elif all(isinstance(r, dict) for r in obj):
                keys = []
                for r in obj:
                    for k in r.keys():
                        if k not in keys:
                            keys.append(k)
                grid = [[str(k) for k in keys]] + [[_plain(r.get(k)) for k in keys] for r in obj]
            else:
                grid = [[_plain(v)] for v in obj]
        else:
            grid = [[_plain(obj)]]
    note = None
    if grid and len(grid) * max(len(r) for r in grid) > max_cells:
        keep = max(1, max_cells // max(len(r) for r in grid))
        note = "output truncated to %d of %d rows" % (keep, len(grid))
        grid = grid[:keep]
    return grid, note


def runtime_info(gpu_state):
    packages = {}
    for name in ("pandas", "numpy", "matplotlib", "cudf", "cupy", "polars", "pyarrow", "langchain", "deepagents", "langgraph"):
        m = sys.modules.get(name)
        if m is not None:
            v = getattr(m, "__version__", None)
            if v is None:
                try:
                    from importlib.metadata import version as _v

                    v = _v(name)
                except Exception:
                    v = ""
            packages[name] = str(v)
    packages["gpu"] = gpu_state
    return {"name": "python-server", "version": sys.version.split()[0], "packages": packages}


def run_cell(req):
    """Execute one request in this process and return the result dict."""
    code = req.get("code") or ""
    snapshot = req.get("snapshot") or {"tables": [], "current": {"table": 0, "row": 0, "col": 0}}
    gpu = bool(req.get("gpu"))
    limits = req.get("limits") or {}
    max_cells = int(limits.get("maxCells") or 200000)

    gpu_state = "off"
    if gpu:
        try:
            import cudf.pandas  # noqa: F401

            cudf.pandas.install()
            import cudf as _cudf

            gpu_state = "cudf " + str(_cudf.__version__)
        except Exception as e:  # no GPU / no RAPIDS: run on the CPU and say so
            gpu_state = "unavailable: " + (str(e).splitlines() or ["?"])[0][:120]
    try:
        import matplotlib

        matplotlib.use("Agg")
    except Exception:
        pass
    # limits apply to the cell's own work, after the runtime's imports (in the warm host they are
    # inherited from the parent; in a single run they happen just above). The memory cap is lifted
    # only when the run is actually on the GPU — a GPU request that fell back to the CPU keeps it.
    set_limits(limits, gpu_state.startswith("cudf"))

    q = _Q(snapshot)
    # an agent cell: the companion's context, tools and model from the environment the server set
    companion = None
    agent_error = None
    if req.get("agent"):
        try:
            cdir = os.environ.get("GRIDWRIGHT_COMPANION_DIR") or req.get("companionDir")
            if cdir and cdir not in sys.path:
                sys.path.insert(0, cdir)
            from cell import from_env

            companion = from_env()
        except Exception as e:  # the cell still runs; `companion` says why it is not there
            agent_error = "%s: %s" % (type(e).__name__, e)
    real_stdout = sys.stdout
    out = io.StringIO()
    err = io.StringIO()
    sys.stdout = out
    sys.stderr = err
    os.environ.setdefault("MPLBACKEND", "Agg")
    result = {"ok": False, "error": "", "std_out": "", "deps": [], "runtime": {}}
    try:
        tree = ast.parse(code, mode="exec")
        last = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        g = {"__name__": "__main__", "q": q}
        if req.get("agent"):
            if companion is None:
                raise RuntimeError("the companion is not available to this cell: " + (agent_error or "unknown"))
            g["companion"] = companion
        if last is not None:
            body = ast.Module(body=tree.body[:-1], type_ignores=[])
            exec(compile(body, "<cell>", "exec"), g)
            value = eval(compile(ast.Expression(body=last.value), "<cell>", "eval"), g)
        else:
            exec(compile(tree, "<cell>", "exec"), g)
            value = None
        output, note = convert(value, max_cells)
        std = out.getvalue()
        if note:
            std = (std + "\n" if std else "") + note
        result = {"ok": True, "output": output, "std_out": std, "deps": q.deps, "runtime": runtime_info(gpu_state)}
        if companion is not None:
            result["agent"] = {"records": companion.gw.records, "proposals": companion.gw.proposals, "runs": companion.gw.runs, "steps": companion.gw.steps}
    except BaseException as e:  # SystemExit, MemoryError and KeyboardInterrupt included
        tb = traceback.format_exc()
        # keep the user's frames only: from the first <cell> frame, minus this runner's own frames
        idx = tb.find('File "<cell>"')
        if idx >= 0:
            lines = tb[idx:].splitlines()
            kept = []
            skip = False
            for line in lines:
                if line.lstrip().startswith('File "') and __file__ in line:
                    skip = True
                    continue
                if skip and line.startswith("    "):
                    continue
                skip = False
                kept.append(line)
            msg = "\n".join(kept)
        else:
            msg = "%s: %s" % (type(e).__name__, e)
        if err.getvalue():
            msg = err.getvalue() + "\n" + msg
        result = {"ok": False, "error": msg.strip(), "std_out": out.getvalue(), "deps": q.deps, "runtime": runtime_info(gpu_state)}
    finally:
        sys.stdout = real_stdout
        sys.stderr = sys.__stderr__
    return result


def main_once():
    """Single run: request on stdin, result after the marker on stdout (used for probes and GPU runs)."""
    req = json.loads(sys.stdin.read() or "{}")
    result = run_cell(req)
    sys.stdout.write(MARKER)
    sys.stdout.write(json.dumps(result, default=str))
    sys.stdout.flush()


def serve():
    """Warm host: import the heavy libraries once, then fork a fresh child per request.

    Protocol (one JSON object per line): stdin {"id": n, ...request, "timeoutMs": t}
    → stdout {"id": n, "result": {...}}. The child runs with its own resource limits and is
    killed (whole process group) when the deadline passes; nothing of a run survives in the host.
    """
    import select

    for name in ("numpy", "pandas"):
        try:
            __import__(name)
        except Exception:
            pass
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot  # noqa: F401
    except Exception:
        pass
    out = sys.stdout
    sys.stdout.write(json.dumps({"ready": True, "version": sys.version.split()[0]}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        timeout = float(req.get("timeoutMs") or 60000) / 1000.0
        r, w = os.pipe()
        pid = os.fork()
        if pid == 0:  # child
            try:
                os.close(r)
                os.setsid()
                devnull = os.open(os.devnull, os.O_RDWR)
                os.dup2(devnull, 0)
                os.dup2(devnull, 1)
                result = run_cell(req)
                data = json.dumps(result, default=str).encode("utf-8")
                view = memoryview(data)
                while len(view):
                    n = os.write(w, view)
                    view = view[n:]
            finally:
                os._exit(0)
        os.close(w)
        chunks = []
        deadline = time.monotonic() + timeout
        timed_out = False
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            ready, _, _ = select.select([r], [], [], remaining)
            if not ready:
                continue
            chunk = os.read(r, 1 << 16)
            if not chunk:
                break
            chunks.append(chunk)
        if timed_out:
            try:
                os.killpg(pid, signal.SIGKILL)
            except Exception:
                pass
        os.close(r)
        try:
            _, status_code = os.waitpid(pid, 0)
        except Exception:
            status_code = 0
        # nothing of a run may outlive it: stop anything it left running in its process group
        try:
            os.killpg(pid, signal.SIGKILL)
        except Exception:
            pass
        result = None
        if chunks and not timed_out:
            try:
                result = json.loads(b"".join(chunks).decode("utf-8"))
            except Exception:
                result = None
        if result is None:
            if timed_out:
                err = "time limit of %d s exceeded" % int(timeout)
            elif os.WIFSIGNALED(status_code):
                err = "the process was killed (signal %d) — memory limit?" % os.WTERMSIG(status_code)
            else:
                err = "the process ended without a result (exit %d)" % os.WEXITSTATUS(status_code)
            result = {"ok": False, "error": err, "std_out": "", "deps": [], "runtime": runtime_info("off")}
        out.write(json.dumps({"id": rid, "result": result}, default=str) + "\n")
        out.flush()


if __name__ == "__main__":
    if "--serve" in sys.argv[1:]:
        serve()
    else:
        main_once()
