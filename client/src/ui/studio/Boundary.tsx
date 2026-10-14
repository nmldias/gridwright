// Keeps a failure inside the guided import from taking the workbook down with it: the studio shows
// what went wrong and can be closed or reopened, and the rest of the app keeps working.
import { Component, type ReactNode } from 'react';
import { useStore } from '../../state/store';

export class StudioBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`${this.props.label} failed:`, error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const close = () => {
      useStore.setState({ studio: null, lineage: null });
      this.setState({ error: null });
    };
    return (
      <div className="studio-overlay" role="alertdialog" aria-label={`${this.props.label} failed`}>
        <div className="studio-crash">
          <h2 className="studio-h2">The {this.props.label.toLowerCase()} hit a problem</h2>
          <p className="small">Your data and steps are saved on the server; nothing was lost. Close this and open it again.</p>
          <pre className="small muted">{this.state.error.message}</pre>
          <div className="row">
            <button className="primary" onClick={close}>Close</button>
            <button onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      </div>
    );
  }
}
