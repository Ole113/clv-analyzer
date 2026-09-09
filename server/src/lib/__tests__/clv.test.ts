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
    expect(computeClv("PLAYER_PROP", "OVER", 14, 15.3)).toEqual({ edge: 1.3, beatClv: true });
  });

  it("an Over misses when the number moves down", () => {
    expect(computeClv("PLAYER_PROP", "OVER", 14, 13.1)).toEqual({ edge: -0.9, beatClv: false });
  });

  it("an Under beats the close when the number moves down", () => {
    expect(computeClv("PLAYER_PROP", "UNDER", 22, 20.5)).toEqual({ edge: 1.5, beatClv: true });
  });

  it("an Under misses when the number moves up", () => {
    expect(computeClv("PLAYER_PROP", "UNDER", 22, 23.5)).toEqual({ edge: -1.5, beatClv: false });
  });

  it("treats a perfectly flat line as not beating the close", () => {
    expect(computeClv("PLAYER_PROP", "OVER", 14, 14)).toEqual({ edge: 0, beatClv: false });
    expect(computeClv("PLAYER_PROP", "UNDER", 14, 14)).toEqual({ edge: 0, beatClv: false });
  });

  it("does not accumulate float noise", () => {
    expect(computeClv("PLAYER_PROP", "OVER", 0.1, 0.3).edge).toBe(0.2);
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

  it("counts the social and exchange books OddsJam lists", () => {
    expect(isSportsbookForAverage("fliff", "Fliff", true)).toBe(true);
    expect(isSportsbookForAverage("rebet", "Rebet", true)).toBe(true);
    expect(isSportsbookForAverage("prophetx", "Prophet X", true)).toBe(true);
    expect(isSportsbookForAverage("kalshi", "Kalshi", true)).toBe(true);
  });

  it("does not let a pick'em substring swallow a real sportsbook", () => {
    // "BetRivers" contains "betr", the hint for Betr Picks.
    expect(isSportsbookForAverage("betrivers", "BetRivers", true)).toBe(true);
    expect(isSportsbookForAverage("betrpicks", "Betr Picks", true)).toBe(false);
  });

  it("does not confuse DraftKings with DraftKings Pick6", () => {
    expect(isSportsbookForAverage("draftkings", "DraftKings", true)).toBe(true);
    expect(isSportsbookForAverage("draftkings6", "DraftKings6", true)).toBe(false);
  });
});

describe("CLV direction by market type", () => {
  // Totals and props: an Over beats the close when the number moves UP, because the bettor needed
  // fewer than the market later demanded.
  it("treats a game total like a player prop", () => {
    expect(computeClv("GAME_TOTAL", "OVER", 29.5, 32.5).beatClv).toBe(true);
    expect(computeClv("GAME_TOTAL", "OVER", 29.5, 27.5).beatClv).toBe(false);
    expect(computeClv("GAME_TOTAL", "UNDER", 29.5, 27.5).beatClv).toBe(true);
    expect(computeClv("GAME_TOTAL", "UNDER", 29.5, 32.5).beatClv).toBe(false);
  });

  // Spreads run the OTHER WAY and have no side: holding MORE points than the close is the win.
  it("inverts the direction for spreads, where more points is better", () => {
    // took Seahawks +5.5, closed +3.5 -> held more points than the market ended up offering
    expect(computeClv("SPREAD", null, 5.5, 3.5)).toEqual({ edge: 2, beatClv: true });
    // took +5.5, closed +7.5 -> the market moved away
    expect(computeClv("SPREAD", null, 5.5, 7.5)).toEqual({ edge: -2, beatClv: false });
    // favourite: -4.5 closing at -3.5 is a worse number to hold
    expect(computeClv("SPREAD", null, -4.5, -3.5)).toEqual({ edge: -1, beatClv: false });
    // favourite: -4.5 closing at -6.5 means the bettor laid fewer points than the close
    expect(computeClv("SPREAD", null, -4.5, -6.5)).toEqual({ edge: 2, beatClv: true });
  });

  it("does not count a flat line as beating the close, on any market type", () => {
    expect(computeClv("SPREAD", null, 5.5, 5.5).beatClv).toBe(false);
    expect(computeClv("GAME_TOTAL", "OVER", 29.5, 29.5).beatClv).toBe(false);
    expect(computeClv("PLAYER_PROP", "OVER", 62.5, 62.5).beatClv).toBe(false);
  });
});

describe("matching", () => {
  const row = (over: Partial<ParsedRow>): ParsedRow => ({
    rowIndex: 0,
    marketType: "PLAYER_PROP",
    selectionName: null,
    subjectTeam: null,
    isLive: false,
    boardEvPercent: null,
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
      marketType: "PLAYER_PROP",
      subjectTeam: null,
      matchup: null,
      player: "Puka Nacua",
      statMarket: "Player Receiving Yards",
      side: "OVER",
      externalPropId: "Puka Nacua Over 62.5",
    });
    expect(match?.takenLine).toBe(64.5);
  });

  it("never matches the opposite side or a different market", () => {
    const target = {
      marketType: "PLAYER_PROP" as const,
      subjectTeam: null,
      matchup: null,
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
      marketType: "PLAYER_PROP" as const,
      subjectTeam: null,
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
