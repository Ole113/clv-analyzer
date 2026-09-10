export const dynamic = "force-static";

export default function AboutPage() {
  return (
    <main className="prose">
      <h2 style={{ marginTop: 0 }}>About</h2>
      <p>
        CLV Analyzer is a self-hosted dashboard that tracks closing line value on picks made
        through the <strong>OddsJam</strong> and <strong>PropProfessor</strong> Fantasy Optimizers.
        It runs entirely on the owner&apos;s own machine, for the owner&apos;s own picks — there is
        no shared backend, no other users, and nothing here talks to either site on anyone
        else&apos;s behalf. For how the CLV numbers themselves are computed, see{" "}
        <a href="/methodology">Methodology</a>; this page is about where the data comes from.
      </p>

      <h3>Two pieces, two different ways of reading a page</h3>
      <p>
        There are exactly two points where this project reads anything from OddsJam or
        PropProfessor, and they work differently on purpose.
      </p>

      <h3 id="capture">1. Capturing a pick</h3>
      <p>
        A small Chrome extension adds a checkbox column to the Fantasy Optimizer table on both
        sites. Ticking it reads the row that is <em>already rendered on the page in front of
        you</em> — the same HTML your browser already downloaded to show it to you — and sends
        that row&apos;s text to the dashboard&apos;s own server. This happens only when a signed-in
        person is looking at the page and clicks something. Nothing is fetched, polled, or
        requested in the background at this stage; the extension is reading, not visiting.
      </p>

      <h3 id="closing-read">2. Reading the closing line</h3>
      <p>
        Shortly before a game starts, the dashboard needs one more read of the market to see where
        the line ended up. This is the one piece of automated traffic in the whole system, and it
        only ever goes to <strong>PropProfessor</strong>:
      </p>
      <ul>
        <li>
          A background script, still running inside the same signed-in browser, makes a plain
          request to the JSON endpoint PropProfessor&apos;s own website already calls to draw its
          odds screen (<code>backend.propprofessor.com/screen</code>). It is not a page scrape —
          nothing is rendered, parsed out of HTML, or clicked through; it is the identical API
          request a person&apos;s browser makes when they load that screen themselves.
        </li>
        <li>
          It authenticates the same way a logged-in browser tab already does: with a session token
          the extension observes off a request PropProfessor&apos;s own app was already making, not
          one it manufactures. No credentials are stored outside that session, and the request rate
          is tied to real games starting, not a tight polling loop.
        </li>
      </ul>
      <p>
        <strong>OddsJam is never read this way.</strong> There is no background request to OddsJam
        anywhere in this codebase — closing lines for OddsJam-captured picks are read from
        PropProfessor&apos;s screen too, the same as everything else. This is enforced by an
        automated test in the repository (<code>oddsjam-automation-guard.test.ts</code>) that fails
        the build if any background code so much as names an OddsJam hostname, specifically so this
        cannot regress in a future change without someone noticing.
      </p>

      <h3>What the server itself does</h3>
      <p>
        The server (the part that stores picks and renders this dashboard) never contacts OddsJam
        or PropProfessor at all. It only stores what the extension sends it and serves pages from
        its own database. It is not a crawler, it has no login of its own, and it is not reachable
        from the public internet — it runs on hardware its owner controls and is only ever reached
        over that owner&apos;s private network.
      </p>

      <h3>In short</h3>
      <p>
        Every read is either (a) a human looking at a page they are already signed into, or (b) the
        exact API call that page&apos;s own frontend makes, sent at the pace real games kick off —
        never a server-side crawler, never a shared account, and never OddsJam outside of a page a
        person opened themselves.
      </p>
    </main>
  );
}
