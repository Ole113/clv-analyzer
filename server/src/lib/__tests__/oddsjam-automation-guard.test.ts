import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { planBoardRead } from "../../../../extension/src/background/closing-worker";

/**
 * Guards the one rule in this project that cannot be allowed to rot: the extension never sends
 * automated traffic to OddsJam.
 *
 * The OddsJam subscription is paid a year up front, so a ban is unrecoverable; the PropProfessor
 * account is replaceable. Capture-time code that reads the DOM of an OddsJam page the *user* opened
 * is fine and deliberately untouched by these tests -- it issues no requests. What is forbidden is
 * the background worker initiating contact on a timer, which is exactly what it used to do:
 * `runClosingWork` opened `fantasy.oddsjam.com/fantasy-odds/<book>` in a background tab every 60s.
 *
 * This is the kind of constraint a later refactor undoes without noticing, which is why it is a
 * test rather than a comment.
 */

const BACKGROUND_DIR = join(__dirname, "../../../../extension/src/background");

function backgroundSources(): { file: string; source: string }[] {
  return readdirSync(BACKGROUND_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({ file, source: readFileSync(join(BACKGROUND_DIR, file), "utf8") }));
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
        if (!/^https:\/\/(www\.)?propprofessor\.com\//.test(url)) offenders.push(`${file}: ${url}`);
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

  it("refuses to plan a read for an OddsJam-captured pick instead of pointing it elsewhere", () => {
    const item = {
      id: "bet1",
      site: "ODDSJAM" as const,
      fantasyBook: "betr-picks",
      marketType: "PLAYER_PROP" as const,
      player: "Xavier Robinson",
      subjectTeam: null,
      matchup: "Oklahoma vs Michigan",
      statMarket: "Rushing Yards",
      side: "UNDER" as const,
      externalPropId: null,
      pageUrl: "https://fantasy.oddsjam.com/fantasy-odds/betr-picks",
      gameStartTime: "2026-09-12T00:00:00.000Z",
    };
    const planned = planBoardRead(item);
    expect(planned).toEqual({ reason: expect.stringContaining("disabled") });
    expect(planned).not.toHaveProperty("url");
  });

  it("ignores a stored OddsJam pageUrl rather than treating it as the read target", () => {
    // pageUrl used to take precedence over the board map, so removing OddsJam from that map alone
    // would not have stopped the traffic. Provenance and read-target are separate concerns now.
    const planned = planBoardRead({
      id: "bet2",
      site: "PROPPROFESSOR" as const,
      fantasyBook: "underdog",
      marketType: "PLAYER_PROP" as const,
      player: "Johnathan Montague",
      subjectTeam: null,
      matchup: "Boston College vs. Rutgers",
      statMarket: "Player Receiving Yards",
      side: "OVER" as const,
      externalPropId: null,
      pageUrl: "https://fantasy.oddsjam.com/fantasy-odds/betr-picks",
      gameStartTime: "2026-09-11T14:30:00.000Z",
    });
    expect(planned).toEqual({ url: "https://www.propprofessor.com/fantasy" });
  });
});
