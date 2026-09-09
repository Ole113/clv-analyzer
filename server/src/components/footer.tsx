export function Footer() {
  return (
    <footer className="site-footer">
      <div>
        <strong>CLV Analyzer</strong>
        <span className="muted">
          {" "}
          — closing line value tracking for OddsJam &amp; PropProfessor fantasy picks.
        </span>
      </div>
      <nav>
        <a href="/methodology">Methodology</a>
        <a href="/settings">Settings</a>
        <a href="https://fantasy.oddsjam.com/fantasy-odds/prizepicks" target="_blank" rel="noopener noreferrer">
          OddsJam ↗
        </a>
        <a href="https://www.propprofessor.com/fantasy" target="_blank" rel="noopener noreferrer">
          PropProfessor ↗
        </a>
      </nav>
      <div className="muted small">
        Built by Alex · <a href="mailto:clv@example.com">clv@example.com</a> · self-hosted, runs
        entirely on your own machine
      </div>
    </footer>
  );
}
