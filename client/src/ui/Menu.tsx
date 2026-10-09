import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: ReactNode;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  /** a small grey line under the label */
  hint?: string;
  active?: boolean;
}

export type MenuEntry = MenuItem | 'sep' | { head: string };

/**
 * A small dropdown: a trigger button and a list of actions. Closes after an action, on Escape, or on
 * a click anywhere else. `children` renders a custom body instead of the action list (the Format menu).
 */
export function Menu({ label, title, className, items, children, active, testId }: { label: ReactNode; title?: string; className?: string; items?: MenuEntry[]; children?: ReactNode; active?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // fixed positioning keeps the menu clear of the bar's own scrolling on narrow screens
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 300)) });
  };
  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={`menu-wrap ${className ?? ''}`} ref={ref}>
      <button
        className={`menu-trigger ${open || active ? 'active' : ''}`}
        title={title}
        onClick={() => {
          place();
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        data-menu={testId}
      >
        {label}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu" style={{ top: pos.top, left: pos.left }} onClick={(e) => e.stopPropagation()}>
          {children ??
            items?.map((it, i) =>
              it === 'sep' ? (
                <div key={i} className="menu-sep" />
              ) : 'head' in it ? (
                <div key={i} className="menu-head">
                  {it.head}
                </div>
              ) : (
                <button
                  key={i}
                  role="menuitem"
                  className={`menu-item ${it.active ? 'active' : ''}`}
                  title={it.title}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                >
                  <span>{it.label}</span>
                  {it.hint && <span className="muted small">{it.hint}</span>}
                </button>
              ),
            )}
        </div>
      )}
    </div>
  );
}
