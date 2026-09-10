/** Discord has no public per-user profile URL, so the handle is shown as text, not a link. */
const DISCORD_USERNAME = "Ole113";
const GITHUB_URL = "https://github.com/Ole113";
const EMAIL = "alex.e00113@gmail.com";

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M20.32 4.57A19.79 19.79 0 0 0 15.43 3c-.24.43-.5 1-.69 1.46a18.3 18.3 0 0 0-5.48 0C9.07 4 8.8 3.43 8.56 3a19.74 19.74 0 0 0-4.89 1.57C.56 9.23-.28 13.77.14 18.25A19.9 19.9 0 0 0 6.16 21c.48-.66.92-1.36 1.29-2.1-.71-.27-1.39-.6-2.03-.98.17-.13.34-.26.5-.4a14.2 14.2 0 0 0 12.16 0c.16.14.33.28.5.4-.64.38-1.32.71-2.03.98.37.74.81 1.44 1.29 2.1a19.87 19.87 0 0 0 6.03-2.75c.5-5.19-.84-9.69-3.55-13.68ZM8.02 15.5c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.33-.95 2.42-2.15 2.42Zm7.96 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.33-.95 2.42-2.15 2.42Z" />
    </svg>
  );
}

const LICENSE_URL = "https://github.com/Ole113/clv-analyzer/blob/main/LICENSE";

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

      <div className="footer-columns">
        <nav>
          <a href="/methodology">Methodology</a>
          <a href="/about">About</a>
          <a href="https://fantasy.oddsjam.com/fantasy-odds/prizepicks" target="_blank" rel="noopener noreferrer">
            OddsJam ↗
          </a>
          <a href="https://www.propprofessor.com/fantasy" target="_blank" rel="noopener noreferrer">
            PropProfessor ↗
          </a>
        </nav>

        <section className="footer-contact" aria-label="Contact">
          <span className="contact-label muted">Contact</span>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="contact-item">
            <GitHubIcon />
            Ole113
          </a>
          <a href={`mailto:${EMAIL}`} className="contact-item">
            <MailIcon />
            {EMAIL}
          </a>
          <span className="contact-item is-static" title="Discord username">
            <DiscordIcon />
            {DISCORD_USERNAME}
          </span>
        </section>
      </div>

      <div className="muted small">
        Built by Ole113 ·{" "}
        <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
          MIT License
        </a>
      </div>
    </footer>
  );
}
