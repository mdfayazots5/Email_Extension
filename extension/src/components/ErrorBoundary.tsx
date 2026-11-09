import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Shows a readable message instead of a blank page when a page section crashes.
 * Give it a `key` that changes with the page so switching pages clears the error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Email Extension] Page error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="card page-error" role="alert">
        <h2>This page could not be shown</h2>
        <p className="muted">Something went wrong while drawing this page. Your data is safe. Reload to try again, or open another tab.</p>
        <code>{this.state.error.message}</code>
        <div className="button-row">
          <button className="button button--primary" type="button" onClick={() => location.reload()}>Reload</button>
          <button className="button button--secondary" type="button" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </section>
    );
  }
}
