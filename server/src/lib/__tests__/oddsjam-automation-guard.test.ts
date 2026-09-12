import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { planScreenRead, PROPPROFESSOR_SCREEN_ENDPOINT } from "@clv/shared";

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
  join(REPO, "server/src/lib/pp-token.ts"),
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
  it("has background code that names no host except PropProfessor", () => {
    const offenders: string[] = [];
    for (const { file, source } of backgroundSources()) {
      const urls = codeOnly(source).match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      for (const url of urls) {
        // www for the pages a human opens, backend for the odds screen's JSON endpoint.
        if (!/^https:\/\/(www|backend)\.propprofessor\.com\//.test(url)) {
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
