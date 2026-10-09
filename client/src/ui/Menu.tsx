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

export interface MainAction {
  label: ReactNode;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}

/**
 * A small dropdown: a trigger button and a list of actions. Closes after an action, on Escape, or on
 * a click anywhere else. `children` renders a custom body instead of the action list (the Format menu).
 * With `main`, it is a split button: the main part is a one-click action and only the caret opens the list.
 */
export function Menu({ label, title, className, items, children, active, testId, main }: { label?: ReactNode; title?: string; className?: string; items?: MenuEntry[]; children?: ReactNode; active?: boolean; testId?: string; main?: MainAction }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openedByKeyboard = useRef(false);
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const focusables = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, input') ?? []);
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // fixed positioning keeps the menu clear of the bar's own scrolling on narrow screens
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 300)) });
  };
  useEffect(() => {
    if (!open) return;
    place();
    // keyboard: the first item takes focus when the menu was opened from the keyboard; arrows move,
    // Home/End jump, Escape closes and returns focus to the trigger
    if (openedByKeyboard.current) focusables()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
        return;
      }
      if (!ref.current?.contains(document.activeElement)) return;
      const items = focusables();
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(i + 1) % items.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i - 1 + items.length) % items.length].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={`menu-wrap ${main ? 'split' : ''} ${className ?? ''}`} ref={ref}>
      {main && (
        <button className={`split-main ${main.active ? 'active' : ''}`} title={main.title} disabled={main.disabled} onClick={main.onClick}>
          {main.label}
        </button>
      )}
      <button
        ref={triggerRef}
        className={`menu-trigger ${open || active ? 'active' : ''}`}
        title={title}
        aria-label={main ? 'More options' : undefined}
        onClick={(e) => {
          openedByKeyboard.current = e.detail === 0;
          place();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            e.stopPropagation();
            openedByKeyboard.current = true;
            place();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        data-menu={testId}
      >
        {label}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu" ref={listRef} style={{ top: pos.top, left: pos.left }} onClick={(e) => e.stopPropagation()}>
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
                    close(openedByKeyboard.current);
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
