import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/** Keeps a failure in one screen from blanking the whole application. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel flex flex-col items-center px-6 py-12 text-center" role="alert">
        <AlertTriangle className="mb-2 h-6 w-6 text-amber-500" />
        <p className="text-sm font-medium text-slate-700">This screen hit an unexpected problem.</p>
        <p className="mt-1 max-w-md text-xs text-slate-500">Your data is safe. Reload the page; if it happens again, report what you were doing.</p>
        <button className="link mt-3 text-xs" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
