import { useStore } from '../state/store';
import { newFile } from './files';
import { pickAndImport } from './import';

/**
 * First use: three ways to start, and the example to try. Shown once per fresh document and gone
 * at the first edit, the first open, or a click on its cross.
 */
export function StartCard() {
  const dismiss = () => useStore.setState({ start: false });
  return (
    <div className="start-card" role="dialog" aria-label="Start">
      <div className="row">
        <b className="grow">Start</b>
        <button className="icon" onClick={dismiss} title="Close" aria-label="Close">
          ✕
        </button>
      </div>
      <button
        className="start-choice"
        onClick={() => {
          dismiss();
          pickAndImport();
        }}
      >
        <span>Bring a file in — CSV, Excel, XML, JSON</span>
        <span className="muted small">read and checked first; you decide where it goes</span>
      </button>
      <button
        className="start-choice"
        onClick={() => {
          dismiss();
          useStore.setState({ panel: 'files', filesView: 'templates' });
        }}
      >
        <span>Use a finance template</span>
        <span className="muted small">landed cost, bank reconciliation, 13-week cash, ageing</span>
      </button>
      <button
        className="start-choice"
        onClick={() => {
          dismiss();
          void newFile();
        }}
      >
        <span>Start blank</span>
        <span className="muted small">one empty table on the canvas</span>
      </button>
      <button className="link small" onClick={dismiss} title="Keep the sample table that is already on the canvas">
        Try the example that is on the canvas
      </button>
    </div>
  );
}
