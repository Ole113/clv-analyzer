import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planScreenRead,
  planOddsApiRead,
  oddsApiEventsUrl,
  oddsApiOddsUrl,
  ODDS_API_COST_PER_READ,
  ODDS_API_MAX_BOOKMAKERS,
  PROPPROFESSOR_SCREEN_ENDPOINT,
  decodeOddsJamRequest,
  encodeOddsJamRequest,
  planOddsJamGameStep,
  planOddsJamLink,
  planOddsJamListingStep,
  ODDSJAM_MAX_LOAD_MORE,
  type OddsJamLinkTarget,
} from "@clv/shared";

/**
 * Guards the one rule in this project that cannot be allowed to rot: nothing here ever sends
 * automated traffic to OddsJam.
 *
 * The OddsJam subscription is paid a year up front, so a ban is unrecoverable; the PropProfessor
 * account is replaceable. Code that reads -- or, with OddsJam's written permission, navigates -- an
 * OddsJam tab the *user's own click* opened is fine, and is covered by its own describe block below
 * rather than by these tests. What is forbidden is the background worker initiating contact with no
 * user asking, which is exactly what it used to do: `runClosingWork` opened
 * `fantasy.oddsjam.com/fantasy-odds/<book>` in a background tab every 60s.
 *
 * The server is covered as well as the extension, and that is newer than the rest of this file: the
 * Odds modal's fast path (`pp-screen-read.ts`) reads the odds screen from the Node process instead
 * of routing every click through the extension, so the server now initiates outbound requests too
 * and needs the same rule applied to it. Only that module is listed rather than all of `lib`,
 * because the graders legitimately call ESPN and MLB.
 *
 * This is the kind of constraint a later refactor undoes without noticing, which is why it is a
 * test rather than a comment.
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

/** Server modules that make outbound reads of their own. */
const AUTOMATED_FILES = [
  join(REPO, "server/src/lib/pp-screen-read.ts"),
  join(REPO, "server/src/lib/odds-preview.ts"),
  join(REPO, "server/src/lib/odds-api-read.ts"),
  join(REPO, "server/src/lib/pp-token.ts"),
];

/**
 * Every host this project is permitted to contact automatically.
 *
 * Extended deliberately, one entry at a time, and never widened to a pattern. `www` is the pages a
 * human opens and `backend` the odds screen's JSON endpoint; `api.the-odds-api.com` is the Odds
 * modal's second source -- a third party to both boards, keyed and metered, contacted only when its
 * tab is clicked. The point of listing hosts rather than excluding oddsjam.com is that a *new* host
 * fails this test until someone writes it down here, which is the review step this rule exists for.
 */
const ALLOWED_HOSTS = [
  /^https:\/\/(www|backend)\.propprofessor\.com\//,
  /^https:\/\/api\.the-odds-api\.com\b/,
  // The Odds API's own marketing site, linked from the modal footer and Settings so a user can go
  // and get a key. A link a person clicks, never a fetch.
  /^https:\/\/the-odds-api\.com\b/,
];

function backgroundSources(): { file: string; source: string }[] {
  return [
    ...AUTOMATED_DIRS.flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith(".ts"))
        .map((file) => ({ file, source: readFileSync(join(dir, file), "utf8") }))
    ),
    ...AUTOMATED_FILES.map((path) => ({ file: path, source: readFileSync(path, "utf8") })),
  ];
}

/** Strips comments so prose *about* OddsJam (including this rule's own rationale) is not a match. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("no automated OddsJam traffic", () => {
  it("has background code that names no host outside the allowlist", () => {
    const offenders: string[] = [];
    for (const { file, source } of backgroundSources()) {
      const urls = codeOnly(source).match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      for (const url of urls) {
        if (!ALLOWED_HOSTS.some((allowed) => allowed.test(url))) {
          offenders.push(`${file}: ${url}`);
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

  it("sends an OddsJam-captured pick to PropProfessor rather than back to OddsJam", () => {
    // The capture site is provenance. It must have no influence on where the close is read, or
    // four of the seven stored bets would still be pointed at oddsjam.com.
    const planned = planScreenRead({
      sport: "NCAAF",
      statMarket: "Rushing Yards",
      marketType: "PLAYER_PROP",
    });
    expect(planned).toMatchObject({
      url: PROPPROFESSOR_SCREEN_ENDPOINT,
      body: { league: "NCAAF", market: "Player Rushing Yards" },
    });
    expect(PROPPROFESSOR_SCREEN_ENDPOINT).toMatch(/^https:\/\/backend\.propprofessor\.com\//);
  });

  it("plans a read from the pick's identity alone, never from a stored pageUrl", () => {
    // pageUrl used to take precedence over the board map, so removing OddsJam from that map alone
    // would NOT have stopped the traffic. The planner no longer accepts a URL at all: the only
    // inputs are sport, market and market type, so there is nothing for a stale OddsJam URL to
    // influence.
    expect(planScreenRead.length).toBeLessThanOrEqual(2);
    const params = planScreenRead.toString().slice(0, planScreenRead.toString().indexOf(")"));
    expect(params).not.toMatch(/pageUrl|url/i);
  });
});

describe("The Odds API is a read of its own, not a route back to a board", () => {
  it("plans an OddsJam-captured pick against The Odds API's own host", () => {
    // Same assertion as the PropProfessor one above and for the same reason: the capture site is
    // provenance, and adding a second source must not have introduced a path where it becomes a
    // read target.
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
  // These files now navigate as well as read: OddsJam support was asked in writing whether a Chrome
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
  // The button navigates the tab it opens through OddsJam's pages, so whichever board it is clicked
  // from becomes the referrer OddsJam sees for that navigation. It was briefly on PropProfessor's
  // Fantasy board too; it is not any more, and re-adding it there would hand OddsJam a trail
  // starting on a competitor's site for no benefit at all.
  const adapter = (path: string) => codeOnly(readFileSync(join(REPO, path), "utf8"));

  it("is on the OddsJam adapter", () => {
    expect(adapter("extension/src/content/oddsjam/index.ts")).toMatch(/oddsJamLink:\s*true/);
  });

  it("is on no other adapter", () => {
    const others = [
      "extension/src/content/propprofessor/index.ts",
      "extension/src/content/propprofessor/positive-ev.ts",
    ];
    const offenders = others.filter((path) => /oddsJamLink:\s*true/.test(adapter(path)));
    expect(offenders).toEqual([]);
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
    expect(opened).toBe(
      "https://oddsjam.com/nfl/odds" + encodeOddsJamRequest(target)
    );

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
