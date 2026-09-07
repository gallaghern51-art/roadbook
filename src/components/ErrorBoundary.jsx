import React from 'react';

// A crash in one component must not cost the rider the whole app.
//
// React unmounts the entire tree when a render throws and nothing catches it.
// On a phone that is a black screen with no way back — and this app is
// something people open at a fuel stop with one bar of signal, so "force quit
// and hope" is not an acceptable recovery. It happened for real: a stray
// reference in the Prep board blanked Plan, Prep, Ride and Settings alike,
// because they are all one tree.
//
// The trip itself is safe either way — it lives in localStorage, not in React
// state — so the honest thing to say is exactly that, and then offer the two
// doors that actually work: re-render, or reload.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, key: 0 };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the stack somewhere a person can actually retrieve it. The console
    // is gone the moment a phone app is force-quit.
    try {
      const log = JSON.parse(localStorage.getItem('moto.crash.v1') || '[]');
      log.unshift({
        at: new Date().toISOString(),
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? '').split('\n').slice(0, 8).join('\n'),
        components: String(info?.componentStack ?? '').split('\n').slice(0, 6).join('\n'),
      });
      localStorage.setItem('moto.crash.v1', JSON.stringify(log.slice(0, 5)));
    } catch { /* storage full or unavailable — the screen below still works */ }
  }

  render() {
    const { error, key } = this.state;
    if (!error) return <React.Fragment key={key}>{this.props.children}</React.Fragment>;
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-body">
          <h2>Something in this screen broke.</h2>
          <p>
            Your trips are safe — they are stored on this device, not in the screen
            that failed. Try this screen again, or reload the app.
          </p>
          <div className="crash-actions">
            <button
              type="button"
              className="btn gold"
              onClick={() => this.setState((s) => ({ error: null, key: s.key + 1 }))}
            >
              Try again
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
          <details>
            <summary>What happened</summary>
            <code>{String(error?.message ?? error)}</code>
          </details>
        </div>
      </div>
    );
  }
}
