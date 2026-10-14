import type { ReactNode } from 'react';
import { useStore } from '../state/store';

/** Every side panel starts with its name, its own controls and a way out. */
export function PanelHeader({ title, children, subtitle }: { title: ReactNode; children?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="panel-title">
      <span className="panel-name">{title}</span>
      {subtitle && <span className="muted small panel-sub">{subtitle}</span>}
      <span className="grow" />
      {children}
      <button className="icon panel-close" onClick={() => useStore.setState({ panel: 'none' })} title="Close panel (Esc)" aria-label="Close panel">
        ✕
      </button>
    </div>
  );
}
