import { describe, expect, it } from "vitest";
import { averageClosingLine, computeClv } from "../clv";
import { isSportsbookForAverage } from "@clv/shared";
import { buildMatchKey, findMatchingRow, stripTrailingLine } from "../matching";
import type { ParsedRow } from "@clv/shared";

describe("averageClosingLine", () => {
  it("averages only the books flagged for inclusion", () => {
    const { avg, count } = averageClosingLine([
      { line: 90.5, includedInAverage: true },
      { line: 91.5, includedInAverage: true },
      { line: 62.5, includedInAverage: false }, // pick'em app
      { line: null, includedInAverage: true }, // price-only column
    ]);
    expect(avg).toBe(91);
    expect(count).toBe(2);
  });

  it("returns null (not zero) when no book qualifies", () => {
    expect(averageClosingLine([{ line: 12, includedInAverage: false }])).toEqual({
      avg: null,
      count: 0,
    });
    expect(averageClosingLine([])).toEqual({ avg: null, count: 0 });
  });

  it("handles a single book", () => {
    expect(averageClosingLine([{ line: 24.5, includedInAverage: true }]).avg).toBe(24.5);
  });
});

describe("computeClv", () => {
  it("an Over beats the close when the number moves up", () => {
    expect(computeClv("OVER", 14, 15.3)).toEqual({ edge: 1.3, beatClv: true });
  });

  it("an Over misses when the number moves down", () => {
    expect(computeClv("OVER", 14, 13.1)).toEqual({ edge: -0.9, beatClv: false });
  });

  it("an Under beats the close when the number moves down", () => {
    expect(computeClv("UNDER", 22, 20.5)).toEqual({ edge: 1.5, beatClv: true });
  });

  it("an Under misses when the number moves up", () => {
    expect(computeClv("UNDER", 22, 23.5)).toEqual({ edge: -1.5, beatClv: false });
  });

  it("treats a perfectly flat line as not beating the close", () => {
    expect(computeClv("OVER", 14, 14)).toEqual({ edge: 0, beatClv: false });
    expect(computeClv("UNDER", 14, 14)).toEqual({ edge: 0, beatClv: false });
  });

  it("does not accumulate float noise", () => {
    expect(computeClv("OVER", 0.1, 0.3).edge).toBe(0.2);
  });
});

describe("isSportsbookForAverage", () => {
  it("keeps real sportsbooks quoting a line", () => {
    expect(isSportsbookForAverage("fanduel", "FanDuel", true)).toBe(true);
    expect(isSportsbookForAverage("pinnacle", "Pinnacle", true)).toBe(true);
    // Novig is a real exchange PropProfessor quotes, not a derived no-vig column.
    expect(isSportsbookForAverage("novigapp", "NoVigApp", true)).toBe(true);
  });

  it("drops pick'em apps even when they show a line", () => {
    expect(isSportsbookForAverage("prizepicks5or6pickflex", "PrizePicks (5 or 6 Pick Flex)", true)).toBe(false);
    expect(isSportsbookForAverage("underdogfantasy4pickflex", "Underdog Fantasy (4 Pick Flex)", true)).toBe(false);
    expect(isSportsbookForAverage("betrpicks", "Betr Picks", true)).toBe(false);
  });

  it("drops derived columns and price-only columns", () => {
    expect(isSportsbookForAverage("oddsjamalgoodds", "OddsJam Algo Odds", false)).toBe(false);
    expect(isSportsbookForAverage("fanduel", "FanDuel", false)).toBe(false);
    expect(isSportsbookForAverage("col-7", null, true)).toBe(false);
  });

  it("does not confuse DraftKings with DraftKings Pick6", () => {
    expect(isSportsbookForAverage("draftkings", "DraftKings", true)).toBe(true);
    expect(isSportsbookForAverage("draftkings6", "DraftKings6", true)).toBe(false);
  });
});

describe("matching", () => {
  const row = (over: Partial<ParsedRow>): ParsedRow => ({
    rowIndex: 0,
    player: "Puka Nacua",
    team: null,
    opponent: null,
    matchup: null,
    sport: "NFL",
    statMarket: "Player Receiving Yards",
    side: "OVER",
    takenLine: 62.5,
    fairProbability: null,
    gameStartTimeText: null,
    gameStartTimeIso: null,
    externalPropId: null,
    externalPlayerId: null,
    bookLines: [],
    rawText: "",
    ...over,
  });

  it("strips the moving line off a site row id", () => {
    expect(stripTrailingLine("Aaron Rodgers Over 14")).toBe("aaron rodgers over");
    expect(stripTrailingLine("NFL:GAME:x:y:1789086900:Rec_Yards:Puka_Nacua_Over_62.5")).toContain(
      "puka nacua over"
    );
  });

  it("finds the prop again after the line has moved", () => {
    const rows = [row({ takenLine: 64.5, externalPropId: "Puka Nacua Over 64.5" })];
    const match = findMatchingRow(rows, {
      player: "Puka Nacua",
      statMarket: "Player Receiving Yards",
      side: "OVER",
      externalPropId: "Puka Nacua Over 62.5",
    });
    expect(match?.takenLine).toBe(64.5);
  });

  it("never matches the opposite side or a different market", () => {
    const target = {
      player: "Puka Nacua",
      statMarket: "Player Receiving Yards",
      side: "OVER" as const,
      externalPropId: null,
    };
    expect(findMatchingRow([row({ side: "UNDER" })], target)).toBeNull();
    expect(findMatchingRow([row({ statMarket: "Player Receptions" })], target)).toBeNull();
    expect(findMatchingRow([row({ player: "Cooper Kupp" })], target)).toBeNull();
  });

  it("keeps a stable match key as the line moves", () => {
    const base = {
      site: "ODDSJAM",
      fantasyBook: "prizepicks",
      sport: "NFL",
      player: "Aaron Rodgers",
      statMarket: "Fantasy Score (PrizePicks)",
      side: "OVER",
      gameStartTime: new Date("2026-09-13T17:00:00Z"),
    };
    expect(buildMatchKey(base)).toBe(buildMatchKey({ ...base }));
    expect(buildMatchKey(base)).not.toBe(buildMatchKey({ ...base, side: "UNDER" }));
  });
});
