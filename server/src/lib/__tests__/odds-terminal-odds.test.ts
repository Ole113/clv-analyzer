import { describe, expect, it } from "vitest";
import {
  filterOddsTerminalOdds,
  findMatchingRow,
  isSportsbookForClose,
  normalizeOddsTerminalOdds,
  oddsTerminalBookCoverage,
  type OddsTerminalOddsEntry,
} from "@clv/shared";
import { buildClosingVerdict } from "../closing";
import { readRelayedOdds } from "../odds-terminal-verdict";
import {
  oddsTerminalCapture,
  oddsTerminalPlan,
  parseOddsTerminal,
} from "./support/odds-terminal-fixture";

/**
 * Parsing a real Odds Terminal fixture read.
 *
 * The capture is one live `/api/snapshot?...&fixture_id=<id>` response (Chiefs at Dolphins, five
 * books, 2026-09-24), trimmed to four markets. It carries the things that actually break a parser
 * of this kind, which is why it is a real response rather than a hand-written one:
 *
 *  - **alt lines everywhere**: DraftKings quotes Travis Kelce's receptions at 1.5 through 9.5, and
 *    only one of those is the market. Picking the wrong one is a plausible-looking wrong answer.
 *  - **one-sided quotes**: most alt lines have an over and no under, so anything that assumes a
 *    pair gets nulls.
 *  - **an apostrophe in a player name** ("De'Von Achane") and a lowercase book ("bet365"), the two
 *    strings that broke the first draft of the pair keying.
 *  - **an exchange with real depth** (Novig, `limits.max`), which is the only source in this
 *    project that can fill the modal's liquidity column.
 *  - **a game total with an empty `selection`**, which is how this feed spells a market that names
 *    no player and no team -- and which a "skip entries with no selection" rule silently drops.
 */

describe("a player prop, parsed from the live capture", () => {
  it("finds both sides of the market at the books' own main line", () => {
    const { parsed } = parseOddsTerminal("Receptions");
    expect(parsed.ok).toBe(true);

    const kelceOver = parsed.rows.find((r) => r.player === "Travis Kelce" && r.side === "OVER");
    expect(kelceOver).toBeDefined();
    // Every book in the capture had Kelce at 4.5, and the alt ladder runs 1.5 to 9.5 around it.
    expect(kelceOver!.takenLine).toBe(4.5);
    expect(kelceOver!.bookLines.map((b) => b.line)).toEqual([4.5, 4.5, 4.5]);
    expect(parsed.rows.find((r) => r.player === "Travis Kelce" && r.side === "UNDER")).toBeDefined();
  });

  it("keeps an apostrophe'd name and a lowercase book intact", () => {
    const { parsed } = parseOddsTerminal("Receptions");
    const achane = parsed.rows.find((r) => r.player === "De'Von Achane" && r.side === "OVER");
    expect(achane).toBeDefined();
    expect(achane!.takenLine).toBe(3.5);
  });

  it("carries real liquidity from the exchange, and none from the sportsbooks", () => {
    const { parsed } = parseOddsTerminal("Receptions");
    const kelce = parsed.rows.find((r) => r.player === "Travis Kelce" && r.side === "OVER")!;
    const novig = kelce.bookLines.find((b) => b.bookKey === "novig");
    expect(novig?.liquidity).toBeGreaterThan(0);
    expect(kelce.bookLines.find((b) => b.bookKey === "draftkings")?.liquidity ?? null).toBeNull();
  });

  it("de-vigs from the two sides the feed states rather than parsing a label", () => {
    const { parsed } = parseOddsTerminal("Receptions");
    const kelce = parsed.rows.find((r) => r.player === "Travis Kelce" && r.side === "OVER")!;
    const fanduel = kelce.bookLines.find((b) => b.bookKey === "fanduel")!;
    // -114/-114 both ways is a fair coin once the vig is out.
    expect(fanduel.fairProbability).toBeCloseTo(0.5, 2);
  });

  it("produces a verdict a person can read, over the books that count", () => {
    const { parsed } = parseOddsTerminal("Receptions", "PLAYER_PROP", { atLine: 4.5 });
    const row = findMatchingRow(parsed.rows, {
      marketType: "PLAYER_PROP",
      player: "Travis Kelce",
      subjectTeam: null,
      matchup: "Kansas City Chiefs vs Miami Dolphins",
      statMarket: "Receptions",
      side: "OVER",
      externalPropId: null,
    });
    if (!row) throw new Error("expected the captured row to match");

    const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 4.5, row, null, "ODDS_TERMINAL");
    expect(verdict.avgClosingLine).toBe(4.5);
    expect(verdict.closingBookCount).toBeGreaterThanOrEqual(2);
    expect(verdict.avgClosingPrice).not.toBeNull();
    // A receptions prop sits near a coin flip; anything outside this is a scale mistake.
    expect(Math.abs(verdict.avgClosingPrice as number)).toBeLessThan(400);
    // The pick was taken at the line the field is on, so there is no movement to report.
    expect(verdict.edge).toBe(0);
  });
});

describe("game markets from the same read", () => {
  it("reads a total, whose selection is empty because it names nothing", () => {
    const { parsed } = parseOddsTerminal("Total Points", "GAME_TOTAL");
    expect(parsed.ok).toBe(true);

    const over = parsed.rows.find((r) => r.side === "OVER");
    expect(over).toBeDefined();
    expect(over!.player).toBeNull();
    expect(over!.selectionName).toBe("Over");
    expect(over!.takenLine).toBeGreaterThan(40);
    expect(over!.bookLines.length).toBeGreaterThanOrEqual(3);
  });

  it("reads a spread as two team rows, signed the way each team's own line is", () => {
    const { parsed } = parseOddsTerminal("Point Spread", "SPREAD");
    const chiefs = parsed.rows.find((r) => r.subjectTeam === "Kansas City Chiefs");
    const dolphins = parsed.rows.find((r) => r.subjectTeam === "Miami Dolphins");
    expect(chiefs!.takenLine).toBeLessThan(0);
    expect(dolphins!.takenLine).toBeGreaterThan(0);
  });

  it("reads a moneyline, where the price is the line", () => {
    const { parsed } = parseOddsTerminal("Moneyline", "MONEYLINE");
    const chiefs = parsed.rows.find((r) => r.subjectTeam === "Kansas City Chiefs")!;
    expect(chiefs.bookLines.every((b) => b.price !== null)).toBe(true);
    expect(chiefs.bookLines[0].price).toBeLessThan(0);
  });
});

describe("what a fixture read hands on to the server", () => {
  it("keeps only the asked-for market, and remembers what else was there", () => {
    // The filter runs where the bytes land, because a real fixture read is 2-3 MB and all but a
    // few dozen entries are about markets nobody asked for.
    const { fixture, odds } = oddsTerminalCapture();
    const plan = oddsTerminalPlan("Receptions");
    const filtered = filterOddsTerminalOdds(odds, plan, fixture.id as string);

    expect(filtered.entries.length).toBeGreaterThan(0);
    expect(filtered.entries.length).toBeLessThan(odds.length);
    expect(filtered.entries.every((e) => e.market === "Player Receptions")).toBe(true);
    expect(filtered.marketsSeen).toContain("Total Points");
  });

  it("drops another fixture's entries, which share the same flat array", () => {
    const { fixture, odds } = oddsTerminalCapture();
    const plan = oddsTerminalPlan("Receptions");
    const foreign: OddsTerminalOddsEntry = {
      ...odds.find((o) => o.market === "Player Receptions")!,
      fixture_id: "SOME-OTHER-GAME",
      price: 100000,
    };
    const filtered = filterOddsTerminalOdds([...odds, foreign], plan, fixture.id as string);
    expect(filtered.entries).not.toContainEqual(foreign);
  });

  it("counts how many books answered, which is what decides whether to ask five more", () => {
    const { fixture, odds } = oddsTerminalCapture();
    const plan = oddsTerminalPlan("Receptions");
    const filtered = filterOddsTerminalOdds(odds, plan, fixture.id as string);
    expect(oddsTerminalBookCoverage(filtered.entries)).toBe(3);
    expect(oddsTerminalBookCoverage([])).toBe(0);
  });
});

describe("when the market is not there", () => {
  it("says what the fixture was quoting instead", () => {
    const { parsed } = parseOddsTerminal("Longest Reception");
    expect(parsed.ok).toBe(false);
    // The actionable detail is almost always "it is spelled differently here", so the reason names
    // what was on offer rather than just reporting a miss.
    expect(parsed.reason).toContain("Player Receptions");
  });

  it("reports a miss through the same outcome shape every other source uses", () => {
    const { fixture, odds } = oddsTerminalCapture();
    const plan = oddsTerminalPlan("Receptions");
    const outcome = readRelayedOdds(
      {
        id: "lookup",
        site: "ODDSJAM",
        fantasyBook: "",
        pageUrl: null,
        gameStartTime: null,
        sport: "NFL",
        statMarket: "Receptions",
        marketType: "PLAYER_PROP",
        player: "Somebody Who Did Not Play",
        subjectTeam: null,
        matchup: "Kansas City Chiefs vs Miami Dolphins",
        side: "OVER",
        takenLine: 4.5,
        externalPropId: null,
      },
      plan,
      { fixture, entries: filterOddsTerminalOdds(odds, plan, fixture.id as string).entries }
    );
    expect(outcome.kind).toBe("SELECTION_ABSENT");
    if (outcome.kind === "SELECTION_ABSENT") {
      // Names a few of the players it did see, so a name mismatch is visible rather than mysterious.
      expect(outcome.sampleNames).toContain("Travis Kelce");
    }
  });

  it("returns nothing rather than throwing on a response that is not one", () => {
    const plan = oddsTerminalPlan("Receptions");
    for (const junk of [null, undefined, "nope", 42, {}] as unknown[]) {
      const parsed = normalizeOddsTerminalOdds(junk as OddsTerminalOddsEntry[], plan, {});
      expect(parsed.rows).toEqual([]);
    }
  });
});

describe("the DFS books are shown but never averaged", () => {
  it("keeps PrizePicks out of the closing average", () => {
    // A DFS line beside the sportsbook consensus is the comparison this modal exists to make, so
    // it must be visible -- and it must never move the number it is being compared against.
    expect(isSportsbookForClose("prizepicks", "PrizePicks", true)).toBe(false);
    expect(isSportsbookForClose("sleeper", "Sleeper", true)).toBe(false);
    expect(isSportsbookForClose("draftkings", "DraftKings", true)).toBe(true);
    expect(isSportsbookForClose("novig", "Novig", true)).toBe(true);
  });
});
