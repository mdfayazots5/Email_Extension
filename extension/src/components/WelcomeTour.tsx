import { useEffect, useRef, useState } from "react";
import { WELCOME_STEPS, type WelcomePreview } from "../guide/guide-content";

type WelcomeTourProps = {
  onClose: () => void;
  onAddSamples: () => Promise<void> | void;
  onOpenQueries: () => void;
};

/** First-run walkthrough with Back / Next. All previews show made-up example data. */
export function WelcomeTour({ onClose, onAddSamples, onOpenQueries }: WelcomeTourProps) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const step = WELCOME_STEPS[index];
  const last = index === WELCOME_STEPS.length - 1;

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight" && !last) setIndex((current) => current + 1);
      if (event.key === "ArrowLeft") setIndex((current) => Math.max(0, current - 1));
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [last, onClose]);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>(".tour-next")?.focus();
  }, [index]);

  const addSamples = async () => {
    setBusy(true);
    try { await onAddSamples(); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop welcome-backdrop" role="presentation">
      <section ref={dialogRef} className="modal welcome-tour" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <header className="welcome-header">
          <span className="welcome-step-count">Step {index + 1} of {WELCOME_STEPS.length}</span>
          <button className="welcome-skip" type="button" onClick={onClose}>{last ? "Close" : "Skip tour"}</button>
        </header>
        <div className="welcome-preview" aria-hidden="true"><Preview kind={step.preview} /></div>
        <div className="welcome-body">
          <h2 id="welcome-title">{step.title}</h2>
          {step.body.map((line) => <p key={line}>{line}</p>)}
        </div>
        <footer className="welcome-footer">
          <div className="welcome-dots" role="tablist" aria-label="Guide steps">
            {WELCOME_STEPS.map((item, dot) => (
              <button
                key={item.title}
                type="button"
                role="tab"
                aria-selected={dot === index}
                aria-label={`Step ${dot + 1}: ${item.title}`}
                className={`welcome-dot ${dot === index ? "is-active" : ""}`}
                onClick={() => setIndex(dot)}
              />
            ))}
          </div>
          <div className="button-row">
            {index > 0 && <button className="button button--secondary" type="button" onClick={() => setIndex(index - 1)}>Back</button>}
            {last ? (
              <>
                <button className="button button--secondary" type="button" onClick={onOpenQueries}>Open Queries</button>
                <button className="button button--primary tour-next" type="button" disabled={busy} onClick={() => void addSamples()}>{busy ? "Adding…" : "Add sample queries"}</button>
              </>
            ) : (
              <button className="button button--primary tour-next" type="button" onClick={() => setIndex(index + 1)}>Next</button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

function Example({ children }: { children: React.ReactNode }) {
  return <div className="demo-card"><span className="demo-badge">Example</span>{children}</div>;
}

function Preview({ kind }: { kind: WelcomePreview }) {
  switch (kind) {
    case "intro":
      return (
        <div className="demo-hero">
          <div className="brand-mark demo-logo">EE</div>
          <div className="demo-hero-chips"><span>LinkedIn posts</span><span>→</span><span>Emails</span><span>→</span><span>Your computer</span></div>
        </div>
      );
    case "flow":
      return (
        <ol className="demo-flow">
          {["Queries", "LinkedIn search", "Set filters", "Scan posts", "Results"].map((label, position) => (
            <li key={label}><span>{position + 1}</span>{label}</li>
          ))}
        </ol>
      );
    case "queries":
      return (
        <Example>
          <div className="demo-row demo-row--head"><strong>India</strong><small>2 records</small></div>
          <div className="demo-row"><span className="demo-num">1</span><div><strong>Bengaluru</strong><code>("Software Engineer" OR "Developer") AND "Bengaluru" AND hiring</code></div></div>
          <div className="demo-row"><span className="demo-num">2</span><div><strong>Hyderabad</strong><code>("Software Engineer" OR "Developer") AND "Hyderabad" AND hiring</code></div></div>
        </Example>
      );
    case "linkedin":
      return (
        <Example>
          <div className="demo-bar">
            <strong>Email Extension</strong>
            <label>Country<span className="demo-select">India</span></label>
            <label>Record<span className="demo-select">1. Bengaluru</span></label>
            <span className="demo-btn demo-btn--primary">Start</span>
            <span className="demo-btn demo-btn--danger">Stop</span>
          </div>
        </Example>
      );
    case "filters":
      return (
        <Example>
          <div className="demo-pills"><span>Date posted: Past 24 hours</span><span>Sort by: Latest</span><span>Posts</span></div>
          <div className="demo-panel">
            <strong>Set filters for India</strong>
            <p>Set the filters in LinkedIn, then click Continue.</p>
            <div className="demo-actions"><span className="demo-btn demo-btn--primary">Continue</span><span className="demo-btn">Use saved filters</span><span className="demo-btn">Skip filters</span></div>
          </div>
        </Example>
      );
    case "results":
      return (
        <Example>
          <div className="demo-metrics"><div><strong>12</strong><small>New today</small></div><div><strong>18</strong><small>Collected</small></div><div><strong>3</strong><small>Records</small></div></div>
          <table className="demo-table">
            <tbody>
              <tr><td>recruiter@example.com</td><td>India · Bengaluru</td></tr>
              <tr><td>careers@example.org</td><td>UAE · Dubai</td></tr>
              <tr><td>hr.team@example.net</td><td>UK · London</td></tr>
            </tbody>
          </table>
        </Example>
      );
    case "safety":
      return (
        <ul className="demo-checks">
          <li>6–12 s between scrolls</li>
          <li>Up to 25 searches per day</li>
          <li>600 posts per day</li>
          <li>24 h rest after any LinkedIn warning</li>
        </ul>
      );
    case "finish":
      return (
        <div className="demo-hero">
          <div className="demo-done">✓</div>
          <div className="demo-hero-chips"><span>Add queries</span><span>→</span><span>Open LinkedIn</span><span>→</span><span>Start</span></div>
        </div>
      );
  }
}
