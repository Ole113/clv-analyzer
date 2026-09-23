import { SettingsNav } from "@/components/settings-nav";

export const dynamic = "force-static";

const SECTIONS = [
  { id: "two-pieces", label: "Two ways of reading a page" },
  { id: "capture", label: "1. Capturing a pick" },
  { id: "closing-read", label: "2. Reading the closing line" },
  { id: "server", label: "What the server does" },
  { id: "in-short", label: "In short" },
];

// Updated 2026-09: the PropProfessor account was banned for the automated screen reads section 2
// used to describe. That automation is now permanently disabled -- see the code comments in
// `pp-screen-read.ts` and `closing-reader.ts` -- and closing-line capture is paused rather than
// rewired onto another source. The Odds modal now reads only The Odds API, a keyed third-party
// API that needs no PropProfessor session at all.

export default function AboutPage() {
  return (
    <main>
      <div className="settings-layout">
        <div className="settings-sidebar">
          <h2 style={{ marginTop: 0 }}>About</h2>
          <SettingsNav sections={SECTIONS} ariaLabel="About sections" />
        </div>

        <div className="settings-content prose">
          <p>
            CLV Analyzer is a self-hosted dashboard that tracks closing line value on picks made
            through the <strong>OddsJam</strong> and <strong>PropProfessor</strong> Fantasy Optimizers.
            It runs entirely on the owner&apos;s own machine, for the owner&apos;s own picks — there is
            no shared backend, no other users, and nothing here talks to either site on anyone
            else&apos;s behalf. For how the CLV numbers themselves are computed, see{" "}
            <a href="/methodology">Methodology</a>; this page is about where the data comes from.
          </p>

          <h3 id="two-pieces">Two pieces, two different ways of reading a page</h3>
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
            Shortly before a game starts, the dashboard used to make one more read of the market to see
            where the line ended up, the same way as capture: a background script, still running inside
            a signed-in browser, made a plain request to the JSON endpoint PropProfessor&apos;s own
            website already calls to draw its odds screen (<code>backend.propprofessor.com/screen</code>
            ), authenticated with a session token observed off a request PropProfessor&apos;s own app
            was already making.
          </p>
          <p>
            <strong>That automation is now permanently disabled.</strong> It is what got the
            PropProfessor account banned in September 2026, and nothing in this codebase makes that
            request any more — not on a schedule, and not on demand. Closing-line capture is paused
            rather than rewired onto another source; the code that used to do it is still in the
            extension (<code>closing-reader.ts</code>, <code>closing-worker.ts</code>), unreferenced,
            in case a deliberate, human decision to read PropProfessor again is ever made.
          </p>
          <p>
            The Odds modal — &quot;current odds ↗&quot; on a pick, or the board button the extension
            injects — now reads only <strong>The Odds API</strong>, a keyed, metered third-party API
            unrelated to either PropProfessor or OddsJam. It needs no browser session and is contacted
            only when a person opens or refreshes that modal, never on a timer.
          </p>
          <p>
            <strong>OddsJam is never read automatically either.</strong> There is no background request
            to OddsJam anywhere in this codebase. This is enforced by an automated test in the
            repository (<code>oddsjam-automation-guard.test.ts</code>) that fails the build if any
            background code so much as names an OddsJam hostname, specifically so this cannot regress in
            a future change without someone noticing.
          </p>

          <h3 id="server">What the server itself does</h3>
          <p>
            The server (the part that stores picks and renders this dashboard) never contacts OddsJam
            or PropProfessor at all, and — since the ban — no longer contacts PropProfessor&apos;s odds
            screen the way it briefly did either. It stores what the extension sends it, reads The Odds
            API for the Odds modal, and serves pages from its own database. It is not a crawler, it has
            no login of its own, and it is not reachable from the public internet — it runs on hardware
            its owner controls and is only ever reached over that owner&apos;s private network.
          </p>

          <h3 id="in-short">In short</h3>
          <p>
            Every read left in this system is either (a) a human looking at a page they are already
            signed into, or (b) a keyed request to The Odds API, sent only when someone opens the Odds
            modal — never a server-side crawler, never a shared account, and never PropProfessor or
            OddsJam outside of a page a person opened themselves.
          </p>
        </div>
      </div>
    </main>
  );
}
