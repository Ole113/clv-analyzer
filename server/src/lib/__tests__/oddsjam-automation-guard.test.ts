import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  planOddsApiRead,
  oddsApiEventsUrl,
  oddsApiOddsUrl,
  ODDS_API_COST_PER_READ,
  ODDS_API_MAX_BOOKMAKERS,
  decodeOddsJamRequest,
  encodeOddsJamRequest,
  planOddsJamGameStep,
  planOddsJamLink,
  planOddsJamListingStep,
  ODDSJAM_MAX_LOAD_MORE,
  type OddsJamLinkTarget,
} from "@clv/shared";

/**
 * Guards the rules in this project that cannot be allowed to rot: which sites may be contacted,
 * by what, and on whose say-so.
 *
 * There are three, and they are not the same rule:
 *
 *  1. **OddsJam is never contacted automatically.** The subscription is paid a year up front, so a
 *     ban is unrecoverable. Code that reads -- or, with OddsJam's written permission, navigates --
 *     an OddsJam tab the *user's own click* opened is fine and has its own block below. What is
 *     forbidden is the background worker initiating contact with nobody asking, which is exactly
 *     what it used to do: `runClosingWork` opened `fantasy.oddsjam.com/fantasy-odds/<book>` in a
 *     background tab every 60 seconds.
 *  2. **PropProfessor is never contacted at all, by anything, ever again.** That account was banned
 *     for automated access (2026-09). Every module that read it is deleted rather than disabled,
 *     and the hostname now fails this file wherever it appears in code.
 *  3. **Odds Terminal is contacted from exactly one file, only in response to a click.** It is
 *     account-gated and proxies a paid feed, so it is treated as being in the same risk class. The
 *     defence is structural: one named file may know the host, it holds no credential, and nothing
 *     in it can be driven by a clock.
 *
 * These are tests rather than comments because this is precisely the kind of constraint a later
 * refactor undoes without noticing.
 */

const REPO = join(__dirname, "../../../..");

/**
 * Every directory whose code can issue a request on a timer: the extension's background worker,
 * and the shared read-planning modules it delegates to. Capture-time parsers are deliberately not
 * covered -- they read the DOM of a page the user opened and send nobody anything.
 */
const AUTOMATED_DIRS = [
  join(REPO, "extension/src/background"),
  join(REPO, "shared/src/sources"),
];

/**
 * Server modules that make outbound reads of their own -- plus one that pointedly does not.
 *
 * `odds-terminal-verdict.ts` issues no request at all: it is handed entries the extension already
 * fetched. It is listed here precisely *because* of that, so the allowlist check proves it names
 * no host -- the property that makes a server-side read of Odds Terminal impossible rather than
 * merely absent.
 */
const AUTOMATED_FILES = [
  join(REPO, "server/src/lib/odds-preview.ts"),
  join(REPO, "server/src/lib/odds-api-read.ts"),
  join(REPO, "server/src/lib/odds-terminal-verdict.ts"),
];

/**
 * Every host this project is permitted to contact automatically, and the file allowed to name it.
 *
 * Extended deliberately, one entry at a time, and never widened to a pattern -- the point of an
 * allowlist rather than a denylist is that a *new* host fails this test until someone writes it
 * down here, which is the review step this rule exists for.
 *
 * `backend.propprofessor.com` and `www.propprofessor.com` were on this list and are now banned
 * outright by the block below.
 */
const ALLOWED_HOSTS: { pattern: RegExp; onlyIn?: string }[] = [
  // The Odds modal's metered API source: a third party to both boards, keyed, and contacted only
  // when its own tab is clicked.
  { pattern: /^https:\/\/api\.the-odds-api\.com\b/ },
  // Its marketing site, linked from the modal footer and Settings so a user can go and get a key.
  // A link a person clicks, never a fetch.
  { pattern: /^https:\/\/the-odds-api\.com\b/ },
  // Odds Terminal, in the one background file permitted to contact it. Everything about why that
  // is allowed, and under what limits, is asserted in its own block further down.
  { pattern: /^https:\/\/oddsterminal\.org\b/, onlyIn: "odds-terminal-read.ts" },
];

function sourcesIn(dir: string): { file: string; source: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({ file, source: readFileSync(join(dir, file), "utf8") }));
}

function backgroundSources(): { file: string; source: string }[] {
  return [
    ...AUTOMATED_DIRS.flatMap((dir) => sourcesIn(dir)),
    ...AUTOMATED_FILES.map((path) => ({ file: path, source: readFileSync(path, "utf8") })),
  ];
}

/** Every `.ts` file the extension ships, whatever directory it lives in. */
function extensionSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts")) out.push({ file: path, source: readFileSync(path, "utf8") });
    }
  };
  walk(join(REPO, "extension/src"));
  return out;
}

/**
 * Strips comments so prose *about* a site (including this rule's own rationale) is not a match.
 *
 * The `[^:]` in the line-comment pattern is not a nicety -- without it this whole file was asleep.
 * A bare `\/\/[^\n]*` also matches the `//` inside `"https://oddsjam.com"`, so every URL literal in
 * the codebase was truncated to `"https:` before the checks below ever saw it. That made the
 * allowlist test vacuous (it could never find a URL to reject) and the hostname bans blind to any
 * host written with a scheme -- which is how every host in this project is written. Found 2026-09
 * while adding the Odds Terminal rule, by checking that a deliberately planted violation actually
 * failed the test. It did not.
 *
 * The captured leading character is put back so `a /* x *\/ b` and `x // y` still strip correctly.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("no automated OddsJam traffic", () => {
  it("has background code that names no host outside the allowlist", () => {
    const offenders: string[] = [];
    for (const { file, source } of backgroundSources()) {
      const urls = codeOnly(source).match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      for (const url of urls) {
        const allowed = ALLOWED_HOSTS.find((entry) => entry.pattern.test(url));
        if (!allowed) offenders.push(`${file}: ${url}`);
        else if (allowed.onlyIn && !file.endsWith(allowed.onlyIn)) {
          offenders.push(`${file}: ${url} (only ${allowed.onlyIn} may name this host)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names no oddsjam hostname in background code", () => {
    // Deliberately the *hostname*, not the word: `site: "ODDSJAM" | "PROPPROFESSOR"` is a capture
    // site and has to stay, since picks are still ticked on OddsJam boards. A bare `oddsjam.com`
    // is what would let a tab or a fetch reach them.
    const offenders = backgroundSources()
      .filter(({ source }) => /oddsjam\.com/i.test(codeOnly(source)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

/**
 * The PropProfessor ban, written as code.
 *
 * This used to be an allowlist entry. It is an absence assertion now, and the difference is the
 * point: there is no longer any file in this project that is *permitted* to name that host, so a
 * future "just one read" has nowhere to live that does not fail this test.
 *
 * The removal went further than switching the reads off, at the user's instruction: the capture
 * adapter, the AG Grid bridge, the +EV Kelly button, the token bridge and its relay, the closing
 * reader and worker, the server-side screen reader and the token route are all deleted, and the
 * manifest asks for no PropProfessor host permission. An unreferenced reader is one import away
 * from being a reader again.
 */
describe("nothing reads PropProfessor, anywhere", () => {
  const HOST = /propprofessor\.com/i;

  it("names the host in no extension file at all", () => {
    const offenders = extensionSources()
      .filter(({ source }) => HOST.test(codeOnly(source)))
      .map(({ file }) => file.replace(REPO, ""));
    expect(offenders).toEqual([]);
  });

  it("names the host in no background, shared-source or server-read module", () => {
    const offenders = backgroundSources()
      .filter(({ source }) => HOST.test(codeOnly(source)))
      .map(({ file }) => file.replace(REPO, ""));
    expect(offenders).toEqual([]);
  });

  it("asks for no PropProfessor permission and injects no script there", () => {
    const manifest = readFileSync(join(REPO, "extension/manifest.json"), "utf8");
    expect(manifest).not.toMatch(HOST);
    // The content scripts that used to run there are gone from the build too, not just unlisted.
    expect(existsSync(join(REPO, "extension/src/content/propprofessor"))).toBe(false);
    expect(readFileSync(join(REPO, "extension/build.mjs"), "utf8")).not.toMatch(/propprofessor/i);
  });

  it("keeps no module that could read it, even unreferenced", () => {
    const gone = [
      "extension/src/background/pp-token.ts",
      "extension/src/background/closing-reader.ts",
      "extension/src/background/closing-worker.ts",
      "extension/src/background/odds-preview-worker.ts",
      "server/src/lib/pp-screen-read.ts",
      "server/src/lib/pp-token.ts",
      "server/src/app/api/pp-token/route.ts",
      "server/src/scripts/dry-run-closing.ts",
      "shared/src/sources/propprofessor-screen.ts",
      "shared/src/parsers/propprofessor.ts",
    ];
    expect(gone.filter((path) => existsSync(join(REPO, path)))).toEqual([]);
  });
});

/**
 * Odds Terminal: one file, no clock, no credential.
 *
 * This is the exception, and it is written as one. Every other background module reads only our own
 * server; this one reads a third-party, account-gated site. What makes that acceptable is not care,
 * it is the set of limits below -- each asserted here, because a rule of this kind is exactly what
 * a later refactor undoes without noticing.
 *
 * The shape this replaced is worth naming, because it looked safer and was not: the read used to
 * happen in a content script inside a tab the click opened. That kept the host out of background
 * code, but it opened a tab nobody asked for on every click and it never once worked -- it read
 * props from an SSE endpoint that answers a fixture subscription with 200 and then silence. A
 * background fetch on the browser's own session is quieter *and* honest about where the request
 * comes from.
 */
describe("Odds Terminal is read by one file, only when someone clicks", () => {
  const reader = join(REPO, "extension/src/background/odds-terminal-read.ts");
  const source = () => codeOnly(readFileSync(reader, "utf8"));

  it("is the only background file that knows where Odds Terminal is", () => {
    // The hostname, not the word: the service worker legitimately calls `readOddsTerminal`, and
    // naming the reader is not the same as being able to reach the site without it.
    const offenders = sourcesIn(join(REPO, "extension/src/background"))
      .filter(
        ({ file, source }) =>
          file !== "odds-terminal-read.ts" &&
          (/oddsterminal\.org/i.test(codeOnly(source)) || /ODDS_TERMINAL_ORIGIN/.test(codeOnly(source)))
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("has no timer, alarm or observer anywhere in it", () => {
    // The property that separates this from the automation that got PropProfessor banned: there is
    // no clock in it. A read happens because a person clicked, or it does not happen.
    //
    // `setTimeout` is deliberately not banned -- the module uses one per request, to abort a fetch
    // that hangs, which is the opposite of a scheduler. `setInterval` and `chrome.alarms` are what
    // would make a read repeat, and those are what must never appear.
    for (const pattern of [/setInterval/, /chrome\.alarms/, /MutationObserver/, /requestIdleCallback/]) {
      expect(source(), `${pattern} in odds-terminal-read.ts`).not.toMatch(pattern);
    }
  });

  it("captures no credential of any kind", () => {
    // The session is the browser's own: Chrome attaches the cookie because the extension holds a
    // host permission, and this code never sees it. Anything that read, stored or forwarded one
    // would be the PropProfessor token bridge again under a new name.
    for (const pattern of [/chrome\.cookies/, /document\.cookie/, /authorization/i, /bearer/i, /chrome\.storage/]) {
      expect(source(), `${pattern} in odds-terminal-read.ts`).not.toMatch(pattern);
    }
    expect(source()).toMatch(/credentials:\s*"include"/);
  });

  it("opens no tab and navigates nothing", () => {
    for (const pattern of [/chrome\.tabs\.create/, /chrome\.tabs\.update/, /window\.open/, /location\./]) {
      expect(source(), `${pattern} in odds-terminal-read.ts`).not.toMatch(pattern);
    }
    // And the modal that triggers it does not either -- this is what the user asked for: the odds
    // appear, and no tab is opened on a third-party site.
    const modal = codeOnly(
      readFileSync(join(REPO, "extension/src/content/shared/odds-modal.ts"), "utf8")
    );
    expect(modal).not.toMatch(/window\.open\(/);
    expect(modal).not.toMatch(/chrome\.tabs\./);
  });

  it("builds every request URL through the one guarded helper", () => {
    // `oddsTerminalUrl` refuses anything that is not a rooted relative path, and the planners
    // cannot produce anything else -- so no response, setting or stale URL can send a read
    // somewhere other than the one host this file is allowed to reach.
    const calls = source().match(/\bfetch\s*\(([^,)]*)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/oddsTerminalUrl\(/);
    }
  });

  it("is reached only from a message handler, never from a scheduled one", () => {
    // The worker's alarm exists for the capture queue, and that is all it may drive.
    const worker = codeOnly(
      readFileSync(join(REPO, "extension/src/background/service-worker.ts"), "utf8")
    );
    const alarmHandler = worker.slice(worker.indexOf("chrome.alarms.onAlarm.addListener"));
    expect(alarmHandler).not.toMatch(/oddsTerminal|readOddsTerminal/i);
    expect(worker).toMatch(/readOddsTerminal\(/);
  });
});

describe("The Odds API is a read of its own, not a route back to a board", () => {
  it("plans an OddsJam-captured pick against The Odds API's own host", () => {
    // The capture site is provenance, and adding a second source must not have introduced a path
    // where it becomes a read target.
    const planned = planOddsApiRead({
      sport: "NFL",
      statMarket: "Receiving Yards",
      marketType: "PLAYER_PROP",
    });
    expect(planned).toMatchObject({ sportKey: "americanfootball_nfl", market: "player_reception_yds" });
    if ("kind" in planned) throw new Error("expected a plan");
    expect(oddsApiEventsUrl(planned, "KEY")).toMatch(/^https:\/\/api\.the-odds-api\.com\//);
    expect(oddsApiOddsUrl(planned, "evt", "KEY")).toMatch(/^https:\/\/api\.the-odds-api\.com\//);
  });

  it("plans from the pick's identity alone, never from a stored pageUrl", () => {
    expect(planOddsApiRead.length).toBeLessThanOrEqual(2);
    const source = planOddsApiRead.toString();
    expect(source.slice(0, source.indexOf(")"))).not.toMatch(/pageUrl|url/i);
  });

  it("never spends more than one credit on a read", () => {
    // The cost formula is `unique markets x regions`, and a group of ten named bookmakers bills as
    // one region. One market key and at most ten books is therefore exactly one credit -- the
    // number the whole design is arranged around, and a silent regression here would multiply
    // every user's spend against a 500-a-month free quota.
    const planned = planOddsApiRead({
      sport: "NBA",
      statMarket: "Points",
      marketType: "PLAYER_PROP",
    });
    if ("kind" in planned) throw new Error("expected a plan");
    expect(planned.market).not.toContain(",");
    expect(planned.bookmakers.length).toBeLessThanOrEqual(ODDS_API_MAX_BOOKMAKERS);
    expect(ODDS_API_MAX_BOOKMAKERS).toBe(10);
    expect(ODDS_API_COST_PER_READ).toBe(1);
  });
});

describe("OddsJam-site scripting stays user-initiated", () => {
  // `extension/src/content/oddsjam-site/*.ts` intentionally name oddsjam.com -- unlike everything
  // else this file checks, that is the entire point. They are deliberately NOT in AUTOMATED_DIRS
  // above, which would fail them for reading data a page load the user asked for already put in
  // front of them.
  //
  // These files navigate as well as read: OddsJam support was asked in writing whether a Chrome
  // extension may use scripting to open OddsJam odds pages, naming the exact `/game/<slug>?market=`
  // shape, and answered "this will not be an issue" (2026-09-21). So `resolve.ts` may drive the tab
  // the user's own click opened -- listing page to game page to game page with the market filter --
  // and may press the listing's "Load more games" button to find a game further down the slate.
  //
  // What that permission does NOT cover, and what the rest of this file is about, is reaching
  // OddsJam with no user asking. The checks below are what keep the new capability inside that
  // line: no request is ever originated, no tab is ever opened, nothing navigates except in
  // response to a decoded request, and the capture half stays purely passive.
  const dir = join(REPO, "extension/src/content/oddsjam-site");
  const read = (file: string) => codeOnly(readFileSync(join(dir, file), "utf8"));
  const files = () => readdirSync(dir).filter((f) => f.endsWith(".ts"));

  /** Originating contact of its own, as opposed to navigating the tab it is already in. This is the
   *  distinction the permission turns on, so it is asserted against every file including the one
   *  allowed to navigate. */
  const ORIGINATES_CONTACT = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /EventSource/,
    /\bnew WebSocket\b/,
    /chrome\.tabs\.create/,
    /chrome\.tabs\.update/,
    /window\.open/,
  ];

  /** Taking the tab somewhere. Permitted, but only in `resolve.ts`. */
  const NAVIGATES = [/location\.assign/, /location\.replace/, /location\.href\s*=/, /\.click\s*\(/];

  it("issues no request and opens no tab, in any of its files", () => {
    const offenders: string[] = [];
    for (const file of files()) {
      const source = read(file);
      for (const pattern of ORIGINATES_CONTACT) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("confines navigation to resolve.ts, leaving capture passive", () => {
    // The split is the reason a user who merely browses oddsjam.com can never be navigated by this
    // extension: capture runs on every matching page, and it cannot move the tab even by accident.
    const offenders: string[] = [];
    for (const file of files().filter((f) => f !== "resolve.ts")) {
      const source = read(file);
      for (const pattern of NAVIGATES) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gates resolve.ts on a request decoded from the URL before anything else", () => {
    // Its entry point must bail on a page opened without a request -- an ordinary visit to
    // oddsjam.com. Asserted structurally because the alternative (importing a content script into
    // a Node test) would mean stubbing the whole DOM to prove one early return.
    const source = read("resolve.ts");
    const entry = source.slice(source.indexOf("export function startResolve"));
    expect(entry).toMatch(/decodeOddsJamRequest\(location\.hash\)[\s\S]{0,80}if \(!request\) return;/);
  });
});

describe("the deep-link button is mounted on OddsJam's own board only", () => {
  it("is on the OddsJam adapter, and there is no other adapter left", () => {
    const adapter = codeOnly(
      readFileSync(join(REPO, "extension/src/content/oddsjam/index.ts"), "utf8")
    );
    expect(adapter).toMatch(/oddsJamLink:\s*true/);
    // The PropProfessor adapter used to carry it too, which handed OddsJam a navigation trail
    // starting on a competitor's site. Both that adapter and the question are gone.
    expect(existsSync(join(REPO, "extension/src/content/propprofessor"))).toBe(false);
  });
});

describe("the OddsJam resolve pipeline terminates", () => {
  const target: OddsJamLinkTarget = {
    sport: "NFL",
    statMarket: "Receiving Yards",
    marketType: "PLAYER_PROP",
    team: "New York Giants",
    opponent: "Los Angeles Rams",
    gameStartTimeIso: null,
  };
  const links = [
    { slug: "giants-vs-rams-odds--78014-37430-26-38", awayTeam: "Giants", homeTeam: "Rams" },
  ];

  it("walks a cold cache from the sport listing to the exact market URL", () => {
    // The whole point of the feature: nothing captured, and the click still ends on the market.
    const opened = planOddsJamLink(target, [], {});
    expect(opened).toBe("https://oddsjam.com/nfl/odds" + encodeOddsJamRequest(target));

    const request = decodeOddsJamRequest(new URL(opened!).hash);
    expect(request).toEqual(target);

    const fromListing = planOddsJamListingStep(request!, "nfl", links, {
      hasLoadMore: true,
      loadMoreCount: 0,
    });
    expect(fromListing).toEqual({
      kind: "navigate",
      url: `https://oddsjam.com/game/${links[0].slug}` + encodeOddsJamRequest(target),
    });

    const vocabulary = [{ id: "player_reception_yds", label: "Player Receiving Yards" }];
    const fromGame = planOddsJamGameStep(request!, links[0].slug, null, vocabulary);
    expect(fromGame).toEqual({
      kind: "navigate",
      url: "https://oddsjam.com/game/" + links[0].slug + "?market=player_reception_yds",
    });
  });

  it("stops on the URL it just navigated to rather than looping", () => {
    // `planOddsJamGameStep`'s own output arrives back as its next input when the page reloads. If a
    // present `?market=` were not a full stop, that would be an infinite navigation loop on the
    // user's tab -- the single worst failure this feature could have.
    expect(
      planOddsJamGameStep(target, "slug", "player_reception_yds", [
        { id: "player_reception_yds", label: "Player Receiving Yards" },
      ])
    ).toEqual({ kind: "done" });
  });

  it("asks for one more page of the slate, and only up to the cap", () => {
    const miss = { ...target, team: "Chicago Bears", opponent: "Green Bay Packers" };
    expect(
      planOddsJamListingStep(miss, "nfl", links, { hasLoadMore: true, loadMoreCount: 0 })
    ).toEqual({ kind: "load-more" });
    expect(
      planOddsJamListingStep(miss, "nfl", links, {
        hasLoadMore: true,
        loadMoreCount: ODDSJAM_MAX_LOAD_MORE,
      })
    ).toEqual({ kind: "done" });
    expect(
      planOddsJamListingStep(miss, "nfl", links, { hasLoadMore: false, loadMoreCount: 0 })
    ).toEqual({ kind: "done" });
  });

  it("stops rather than guessing when the market is not in OddsJam's vocabulary", () => {
    // Same discipline as everywhere else here: the bare game page is right, a fabricated
    // `?market=` id would be silently wrong.
    expect(planOddsJamGameStep(target, "slug", null, [{ id: "moneyline", label: "Moneyline" }])).toEqual(
      { kind: "done" }
    );
  });

  it("refuses a fragment that is not one of ours", () => {
    // Anything on oddsjam.com can put a fragment in the address bar; only a well-formed request
    // may start the resolver.
    expect(decodeOddsJamRequest("")).toBeNull();
    expect(decodeOddsJamRequest("#section-2")).toBeNull();
    expect(decodeOddsJamRequest("#clv-oj=not%20json")).toBeNull();
    expect(decodeOddsJamRequest("#clv-oj=" + encodeURIComponent('{"sport":"NFL"}'))).toBeNull();
  });
});
