import { useEffect, useRef, useState } from 'react';
import * as book from '../engine/book';
import { useStore } from '../state/store';
import { bindRenderer } from './actions';
import { GridController } from './controller';
import { GridRenderer } from './renderer';
import { CellEditor } from './CellEditor';
import { ContextMenu } from './ContextMenu';

export function GridCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<GridRenderer | null>(null);
  const [viewportTick, setViewportTick] = useState(0);

  useEffect(() => {
    const host = hostRef.current!;
    const r = new GridRenderer();
    let controller: GridController | null = null;
    let disposed = false;
    r.init(host).then(() => {
      if (disposed) {
        r.destroy();
        return;
      }
      controller = new GridController(host, r);
      bindRenderer(r);
      book.setRedraw(() => r.markDirty());
      r.viewportListeners.add(() => setViewportTick((t) => t + 1));
      setRenderer(r);
      r.markDirty();
    });
    const unsub = useStore.subscribe(() => r.markDirty());
    const ro = new ResizeObserver(() => {
      if (r.initialised) r.app.resize();
      r.markDirty();
    });
    ro.observe(host);
    return () => {
      disposed = true;
      unsub();
      ro.disconnect();
      controller?.dispose();
      if (r.initialised) r.destroy();
    };
  }, []);

  return (
    <div className="canvas-host" ref={hostRef} tabIndex={0}>
      {renderer && <CellEditor renderer={renderer} tick={viewportTick} />}
      <ContextMenu host={hostRef.current} />
    </div>
  );
}
