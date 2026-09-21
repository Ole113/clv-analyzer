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
} from "@clv/shared";

/**
 * Guards the one rule in this project that cannot be allowed to rot: nothing here ever sends
 * automated traffic to OddsJam.
 *
 * The OddsJam subscription is paid a year up front, so a ban is unrecoverable; the PropProfessor
 * account is replaceable. Capture-time code that reads the DOM of an OddsJam page the *user* opened
 * is fine and deliberately untouched by these tests -- it issues no requests. What is forbidden is
 * the background worker initiating contact on a timer, which is exactly what it used to do:
 * `runClosingWork` opened `fantasy.oddsjam.com/fantasy-odds/<book>` in a background tab every 60s.
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

describe("OddsJam-site deep links stay read-only", () => {
  // `extension/src/content/oddsjam-site/*.ts` intentionally name oddsjam.com -- unlike everything
  // else this file checks, that is the entire point: a cache of game slugs and market ids built by
  // passively reading pages the user opens themselves (see the module comment on
  // `@clv/shared/oddsjam-site.ts` for why that is the only way this feature can exist at all). They
  // are deliberately NOT added to AUTOMATED_DIRS above, which would fail them for reading data a
  // page load the user asked for already put in front of them.
  //
  // What they must never do is originate a request or a navigation of their own -- that is the one
  // line this rule actually cares about, and this is the complementary check for it.
  const dir = join(REPO, "extension/src/content/oddsjam-site");
  const FORBIDDEN = [/\bfetch\s*\(/, /XMLHttpRequest/, /chrome\.tabs\.create/, /chrome\.tabs\.update/];

  it("issues no request and opens no tab of its own", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = codeOnly(readFileSync(join(dir, file), "utf8"));
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
