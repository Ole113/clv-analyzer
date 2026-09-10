import { describe, expect, it } from "vitest";
import {
  averageClosingLine,
  averageClosingProbability,
  computeClv,
  devigTwoWay,
  liquidityWeight,
  MAX_LIQUIDITY_WEIGHT,
} from "../clv";
import { isSportsbookForAverage } from "@clv/shared";
import { buildMatchKey, findMatchingRow, stripTrailingLine } from "../matching";
import type { ParsedRow } from "@clv/shared";

describe("averageClosingLine", () => {
  it("averages only the books flagged for inclusion", () => {
    const { avg, count } = averageClosingLine([
      { bookKey: "fanduel", line: 90.5, includedInAverage: true },
      { bookKey: "pinnacle", line: 91.5, includedInAverage: true },
      { bookKey: "prizepicks", line: 62.5, includedInAverage: false }, // pick'em app
      { bookKey: "algo", line: null, includedInAverage: true }, // price-only column
    ]);
    expect(avg).toBe(91);
    expect(count).toBe(2);
  });

  it("returns null (not zero) when no book qualifies", () => {
    expect(
      averageClosingLine([{ bookKey: "fanduel", line: 12, includedInAverage: false }])
    ).toEqual({
      avg: null,
      count: 0,
    });
    expect(averageClosingLine([])).toEqual({ avg: null, count: 0 });
  });

  it("handles a single book", () => {
    expect(
      averageClosingLine([{ bookKey: "fanduel", line: 24.5, includedInAverage: true }]).avg
    ).toBe(24.5);
  });

  it("weights a configured book and treats every unweighted book as equally weighted", () => {
    const lines = [
      { bookKey: "pinnacle", line: 90, includedInAverage: true },
      { bookKey: "fanduel", line: 92, includedInAverage: true },
      { bookKey: "caesars", line: 94, includedInAverage: true },
    ];
    // Pinnacle weighted 3x, FanDuel and Caesars left at the default weight of 1 each:
    // (90*3 + 92*1 + 94*1) / 5 = 456/5 = 91.2
    expect(averageClosingLine(lines, { pinnacle: 3 }).avg).toBeCloseTo(91.2);
  });

  it("falls back to a plain mean when no weights are given, even with the same inputs", () => {
    const lines = [
      { bookKey: "pinnacle", line: 90, includedInAverage: true },
      { bookKey: "fanduel", line: 94, includedInAverage: true },
    ];
    expect(averageClosingLine(lines).avg).toBe(92);
    expect(averageClosingLine(lines, {}).avg).toBe(92);
  });

  it("does not divide by zero when every configured weight is zero", () => {
    const lines = [
      { bookKey: "pinnacle", line: 90, includedInAverage: true },
      { bookKey: "fanduel", line: 94, includedInAverage: true },
    ];
    expect(averageClosingLine(lines, { pinnacle: 0, fanduel: 0 }).avg).toBe(92);
  });
});

describe("liquidity weighting", () => {
  it("leaves a book publishing no depth on the default weight", () => {
    // The common case by a wide margin: most sportsbooks report a flat $0. Reading that as "no
    // market" and zeroing them out would delete the entire traditional field from the average.
    expect(liquidityWeight(0)).toBe(1);
    expect(liquidityWeight(null)).toBe(1);
    expect(liquidityWeight(undefined)).toBe(1);
    // Negative is not a thing the screen emits, but it must not produce a negative weight if it did.
    expect(liquidityWeight(-500)).toBe(1);
  });

  it("grows with depth, but slowly and with a ceiling", () => {
    expect(liquidityWeight(1050)).toBeGreaterThan(liquidityWeight(100));
    expect(liquidityWeight(61709)).toBeGreaterThan(liquidityWeight(1050));
    // The point of the cap: PolymarketUS's $61,709 is 60x Pinnacle's $1,050 in real captured data,
    // and a linear weight would make the "consensus" that one book with decoration.
    expect(liquidityWeight(61709)).toBeLessThanOrEqual(MAX_LIQUIDITY_WEIGHT);
    expect(liquidityWeight(10_000_000)).toBe(MAX_LIQUIDITY_WEIGHT);
  });

  it("is a no-op on a field where nobody publishes depth", () => {
    const lines = [
      { bookKey: "pinnacle", line: 90, includedInAverage: true, liquidity: 0 },
      { bookKey: "fanduel", line: 94, includedInAverage: true, liquidity: 0 },
    ];
    expect(averageClosingLine(lines, null, 1, true).avg).toBe(92);
    // And identical when the field never reported liquidity at all.
    const noField = lines.map(({ liquidity: _liquidity, ...rest }) => rest);
    expect(averageClosingLine(noField, null, 1, true).avg).toBe(92);
  });

  it("pulls the average toward the book with money behind it", () => {
    const lines = [
      { bookKey: "pinnacle", line: 90, includedInAverage: true, liquidity: 50_000 },
      { bookKey: "fanduel", line: 94, includedInAverage: true, liquidity: 0 },
    ];
    const avg = averageClosingLine(lines, null, 1, true).avg!;
    expect(avg).toBeLessThan(92);
    // Bounded: pulled toward Pinnacle, never onto it.
    expect(avg).toBeGreaterThan(90);
  });

  it("lets a hand-set weight override the automatic one", () => {
    // The user has said Pinnacle counts triple. FanDuel is the deep book here, so if liquidity were
    // allowed to overwrite the manual weight the average would move the other way.
    const lines = [
      { bookKey: "pinnacle", line: 90, includedInAverage: true, liquidity: 0 },
      { bookKey: "fanduel", line: 94, includedInAverage: true, liquidity: 500 },
    ];
    const manualOnly = averageClosingLine(lines, { pinnacle: 3 }, 1, false).avg!;
    const both = averageClosingLine(lines, { pinnacle: 3 }, 1, true).avg!;
    // Pinnacle keeps exactly its 3 -- not 3 plus something for its own depth, and not a liquidity
    // weight of its own instead. Only FanDuel, which has no manual weight, gains from its depth,
    // so the average moves toward FanDuel but stays on Pinnacle's side of the midpoint.
    expect(manualOnly).toBeCloseTo(91, 6);
    expect(both).toBeGreaterThan(manualOnly);
    expect(both).toBeLessThan(92);
  });
});

describe("de-vigging", () => {
  it("removes the hold and leaves the two sides summing to 1", () => {
    // -110/-110 implies 52.38% each, 104.76% in total. Both sides are the same, so each is 50%.
    expect(devigTwoWay(-110, -110)).toBe(0.5);
    const favourite = devigTwoWay(-130, 110)!;
    const dog = devigTwoWay(110, -130)!;
    expect(favourite + dog).toBeCloseTo(1, 6);
    // The favourite is the more likely side, and de-vigging must not change which one that is.
    expect(favourite).toBeGreaterThan(0.5);
  });

  it("refuses to guess from a one-sided quote", () => {
    // A book quoting one side has published no margin, so there is nothing to remove -- returning
    // the raw implied probability here would report the vig itself as the fair price.
    expect(devigTwoWay(-110, null)).toBeNull();
    expect(devigTwoWay(null, -110)).toBeNull();
    expect(devigTwoWay(null, null)).toBeNull();
    expect(devigTwoWay(0, -110)).toBeNull();
  });

  it("averages fair probabilities across books, skipping those that have none", () => {
    const { avg, count } = averageClosingProbability([
      { bookKey: "fanduel", fairProbability: 0.52 },
      { bookKey: "pinnacle", fairProbability: 0.54 },
      { bookKey: "betmgm", fairProbability: null }, // priced one side only
    ]);
    expect(avg).toBeCloseTo(0.53, 6);
    // Reported so a fair price averaged over two books is never mistaken for one over twelve.
    expect(count).toBe(2);
  });

  it("returns null rather than 0.5 when no book contributed", () => {
    expect(averageClosingProbability([{ bookKey: "fanduel", fairProbability: null }])).toEqual({
      avg: null,
      count: 0,
    });
  });

  it("weights the probability average the same way the line average is weighted", () => {
    const rows = [
      { bookKey: "pinnacle", fairProbability: 0.5 },
      { bookKey: "fanduel", fairProbability: 0.6 },
    ];
    // (0.5*3 + 0.6*1) / 4 = 0.525
    expect(averageClosingProbability(rows, { pinnacle: 3 }).avg).toBeCloseTo(0.525, 6);
    expect(averageClosingProbability(rows).avg).toBeCloseTo(0.55, 6);
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

  // Moneylines run the same taken-minus-close subtraction as a spread, over the raw American-odds
  // price instead of a point number -- the sign works out the same way in both directions.
  it("treats a moneyline like a spread, over price instead of points", () => {
    // favourite: took -150, closed -165 -> the market later demanded more to back them, a better
    // price held.
    expect(computeClv("MONEYLINE", null, -150, -165)).toEqual({ edge: 15, beatClv: true });
    // favourite: took -150, closed -135 -> the price got friendlier after capture, a worse price
    // held.
    expect(computeClv("MONEYLINE", null, -150, -135)).toEqual({ edge: -15, beatClv: false });
    // underdog: took +130, closed +115 -> later bettors got paid less to take the same side.
    expect(computeClv("MONEYLINE", null, 130, 115)).toEqual({ edge: 15, beatClv: true });
    // underdog: took +130, closed +145 -> later bettors got paid more for the same side.
    expect(computeClv("MONEYLINE", null, 130, 145)).toEqual({ edge: -15, beatClv: false });
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

  it("re-finds a moneyline by team, since it has no side to key off", () => {
    // A moneyline's side is always null, so the game-market branch has to key off subjectTeam
    // (like SPREAD) instead of falling into the side-matching branch, which would require
    // null === null on a field that never disambiguates a game market from any other.
    const rows = [
      row({
        marketType: "MONEYLINE",
        player: null,
        side: null,
        subjectTeam: "Seattle Seahawks",
        statMarket: "Moneyline",
        matchup: "Seattle Seahawks vs Los Angeles Rams",
        takenLine: -165,
      }),
    ];
    const target = {
      marketType: "MONEYLINE" as const,
      subjectTeam: "Seattle Seahawks",
      matchup: "Seattle Seahawks vs Los Angeles Rams",
      player: null,
      statMarket: "Moneyline",
      side: null,
      externalPropId: null,
    };
    expect(findMatchingRow(rows, target)?.takenLine).toBe(-165);
    expect(findMatchingRow(rows, { ...target, subjectTeam: "Los Angeles Rams" })).toBeNull();
  });

  it("is stable for the same capture and differs on the fields that identify the pick", () => {
    const base = {
      site: "ODDSJAM",
      marketType: "PLAYER_PROP" as const,
      subjectTeam: null,
      fantasyBook: "prizepicks",
      sport: "NFL",
      player: "Aaron Rodgers",
      statMarket: "Fantasy Score (PrizePicks)",
      side: "OVER",
      takenLine: 24.5,
      gameStartTime: new Date("2026-09-13T17:00:00Z"),
    };
    expect(buildMatchKey(base)).toBe(buildMatchKey({ ...base }));
    expect(buildMatchKey(base)).not.toBe(buildMatchKey({ ...base, side: "UNDER" }));
  });

  it("keys two Alt lines on the same player/stat/side separately", () => {
    // Alt boards offer the same player/stat/side at several lines at once. Ticking both used to
    // collide on one matchKey, so the second tick silently updated the first pick instead of
    // tracking a second one.
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
    expect(buildMatchKey({ ...base, takenLine: 24.5 })).not.toBe(
      buildMatchKey({ ...base, takenLine: 26.5 })
    );
  });
});
