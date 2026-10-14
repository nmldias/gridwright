"""Performance probe: fill a large table, then time single edits (engine + store + render)."""
import sys, time, json
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1400, "height": 900})
    pg.goto(BASE, wait_until="networkidle")
    pg.wait_for_selector(".canvas-host canvas")
    time.sleep(0.5)
    res = pg.evaluate("""async () => {
      const book = window.__gw.book;
      const rows = 5000, cols = 30;
      const values = [];
      for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(c === cols - 1 ? `=SUM(A${r+1}:C${r+1})*2` : String((r * 31 + c * 7) % 1000)); values.push(row); }
      let t0 = performance.now();
      book.apply({ type: 'set_cells', table: 1, row: 0, col: 0, values });
      const fill = performance.now() - t0;
      // single edits with one dependent formula each
      const times = [];
      for (let i = 0; i < 30; i++) {
        const r = 100 + i * 50;
        t0 = performance.now();
        book.apply({ type: 'set_cell', table: 1, row: r, col: 0, input: String(i) });
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      // an edit that feeds a column-wide aggregate
      book.apply({ type: 'set_cell', table: 1, row: 0, col: 5, input: '=SUM(AD:AD)' });
      t0 = performance.now();
      book.apply({ type: 'set_cell', table: 1, row: 2500, col: 0, input: '7' });
      const agg = performance.now() - t0;
      // render time of one frame
      await new Promise(r => requestAnimationFrame(r));
      t0 = performance.now();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const frame = performance.now() - t0;
      return { fill: Math.round(fill), editMedian: Math.round(times[15] * 100) / 100, editP90: Math.round(times[27] * 100) / 100, aggEdit: Math.round(agg * 100) / 100, frame: Math.round(frame) };
    }""")
    print(json.dumps(res))
    b.close()
