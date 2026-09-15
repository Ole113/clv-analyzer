import { describe, expect, it } from "vitest";
import { buildClosingVerdict } from "../closing";
import type { ParsedRow } from "@clv/shared";

/**
 * Book columns copied verbatim from a live OddsJam Fantasy Optimizer row (Aaron Rodgers,
 * Fantasy Score, 2026-09-08) so the exclusion rules are exercised against real board shape:
 * the algo column and the PrizePicks column render a price with no line and must not be averaged.
 */
const oddsJamRow = (overrides: Partial<ParsedRow> = {}): ParsedRow => ({
  rowIndex: 0,
  marketType: "PLAYER_PROP",
  selectionName: null,
  subjectTeam: null,
  isLive: false,
  boardEvPercent: null,
  player: "Aaron Rodgers",
  team: "Atlanta Falcons",
  opponent: "Pittsburgh Steelers",
  matchup: "Atlanta Falcons vs Pittsburgh Steelers",
  sport: "NFL",
  statMarket: "Fantasy Score (PrizePicks)",
  side: "OVER",
  takenLine: 14,
  fairProbability: 0.6238,
  gameStartTimeText: "Sun, Sep 13 : 11:00 AM",
  gameStartTimeIso: "2026-09-13T17:00:00.000Z",
  externalPropId: "Aaron Rodgers Over 14",
  externalPlayerId: null,
  rawText: "",
  bookLines: [
    { bookKey: "oddsjamalgoodds", label: "OddsJam Algo Odds", line: null, price: -165, logoUrl: null, rawText: "-165.82" },
    { bookKey: "prizepicks5or6pickflex", label: "PrizePicks (5 or 6 Pick Flex)", line: null, price: -118, logoUrl: null, rawText: "-118" },
    { bookKey: "draftkings", label: "DraftKings", line: 18.4, price: -157, logoUrl: null, rawText: "18.4 -157" },
    { bookKey: "caesars", label: "Caesars", line: 19.5, price: -175, logoUrl: null, rawText: "19.5 -175" },
  ],
  ...overrides,
});

describe("buildClosingVerdict", () => {
  it("averages only the real sportsbook lines and scores the Over", () => {
    const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 14, oddsJamRow());
    expect(verdict.status).toBe("CLOSED");
    expect(verdict.closingBookCount).toBe(2); // DraftKings + Caesars only
    expect(verdict.avgClosingLine).toBeCloseTo(18.95, 5);
    expect(verdict.edge).toBeCloseTo(4.95, 5);
    expect(verdict.beatClv).toBe(true);
  });

  it("still records every column, including the ones it excludes", () => {
    const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 14, oddsJamRow());
    expect(verdict.closeLines).toHaveLength(4);
    expect(verdict.closeLines.filter((l) => l.includedInAverage).map((l) => l.bookKey)).toEqual([
      "draftkings",
      "caesars",
    ]);
  });

  it("flips the verdict for the same movement on an Under", () => {
    const verdict = buildClosingVerdict("PLAYER_PROP", "UNDER", 14, oddsJamRow());
    expect(verdict.beatClv).toBe(false);
    expect(verdict.edge).toBeCloseTo(-4.95, 5);
  });

  it("uses a weighted average when book weights are passed in", () => {
    // DraftKings 18.4, Caesars 19.5 -- weighting Caesars 3x pulls the average toward it.
    // (18.4*1 + 19.5*3) / 4 = 76.9/4 = 19.225
    const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 14, oddsJamRow(), { caesars: 3 });
    expect(verdict.avgClosingLine).toBeCloseTo(19.225, 5);
  });

  it("reports UNAVAILABLE rather than guessing when no book still quotes a line", () => {
    const row = oddsJamRow({
      bookLines: [
        { bookKey: "oddsjamalgoodds", label: "OddsJam Algo Odds", line: null, price: -165, logoUrl: null, rawText: "-165.82" },
        { bookKey: "prizepicks5or6pickflex", label: "PrizePicks", line: 14, price: -118, logoUrl: null, rawText: "14 -118" },
      ],
    });
    const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 14, row);
    expect(verdict.status).toBe("UNAVAILABLE");
    expect(verdict.avgClosingLine).toBeNull();
    expect(verdict.edge).toBeNull();
    expect(verdict.beatClv).toBeNull();
    expect(verdict.note).toMatch(/no sportsbook/i);
  });

  describe("lookup mode (a board row nobody has picked yet)", () => {
    // Total-bases-shaped board: most books anchor their own main line at 0.5, one sits at 1.5 --
    // the number the user is actually looking at.
    const totalBasesRow = (): ParsedRow =>
      oddsJamRow({
        takenLine: 1.5,
        statMarket: "Total Bases",
        bookLines: [
          { bookKey: "draftkings", label: "DraftKings", line: 0.5, price: -400, logoUrl: null, rawText: "0.5 -400" },
          { bookKey: "fanduel", label: "FanDuel", line: 0.5, price: -380, logoUrl: null, rawText: "0.5 -380" },
          { bookKey: "caesars", label: "Caesars", line: 1.5, price: 192, logoUrl: null, rawText: "1.5 192" },
        ],
      });

    it("averages only the books quoting the exact line being looked up", () => {
      const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 1.5, totalBasesRow(), null, "PP_SCREEN", {
        lookup: true,
      });
      expect(verdict.avgClosingLine).toBe(1.5);
      expect(verdict.closingBookCount).toBe(1); // Caesars only -- DraftKings/FanDuel sit on 0.5
      expect(verdict.avgClosingPrice).toBe(192);
    });

    it("never reports an edge, since nothing has been picked", () => {
      const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 1.5, totalBasesRow(), null, "PP_SCREEN", {
        lookup: true,
      });
      expect(verdict.edge).toBeNull();
      expect(verdict.beatClv).toBeNull();
    });

    it("still shows every book's own line/price in the table untouched", () => {
      const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 1.5, totalBasesRow(), null, "PP_SCREEN", {
        lookup: true,
      });
      expect(verdict.closeLines.map((l) => [l.bookKey, l.line])).toEqual([
        ["draftkings", 0.5],
        ["fanduel", 0.5],
        ["caesars", 1.5],
      ]);
    });

    it("blends every book's own main line together outside lookup mode, for comparison", () => {
      const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 1.5, totalBasesRow());
      expect(verdict.avgClosingLine).toBeCloseTo((0.5 + 0.5 + 1.5) / 3, 5);
      expect(verdict.edge).not.toBeNull();
    });
  });
});
