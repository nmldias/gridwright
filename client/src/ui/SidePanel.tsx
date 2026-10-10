import { useEffect, useRef, type ReactNode } from 'react';
import { useStore } from '../state/store';

const MIN = 320;
const MAX = 900;

/** The side panel: resizable from its left edge on a desktop, closable with Escape when nothing inside is being typed into. */
export function SidePanel({ children }: { children: ReactNode }) {
  const width = useStore((s) => s.panelWidth);
  const touch = useStore((s) => s.touch);
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!drag.current) return;
      const w = Math.max(MIN, Math.min(MAX, drag.current.w + (drag.current.x - e.clientX)));
      useStore.setState({ panelWidth: w });
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = '';
      try {
        localStorage.setItem('gridwright.panelWidth', String(useStore.getState().panelWidth));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);
  return (
    <>
      {!touch && (
        <div
          className="side-resizer"
          title="Drag to resize the panel"
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, w: useStore.getState().panelWidth };
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
          }}
          onDoubleClick={() => useStore.setState({ panelWidth: 420 })}
        />
      )}
      <aside
        className="side"
        ref={ref}
        style={touch ? undefined : { width }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          const t = e.target as HTMLElement;
          if (t.closest('input, textarea, select, [contenteditable], .cm-editor')) return;
          useStore.setState({ panel: 'none' });
        }}
      >
        {children}
      </aside>
    </>
  );
}
