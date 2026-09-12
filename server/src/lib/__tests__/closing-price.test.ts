import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeScreenMarket, planScreenRead, findMatchingRow } from "@clv/shared";
import { americanFromProbability, averageClosingPrice } from "../clv";
import { buildClosingVerdict } from "../closing";

/**
 * The average closing PRICE.
 *
 * This exists for the markets where the line cannot move. A passing-touchdowns prop sits on 2.5 all
 * week -- there is no 2.6 for it to drift to -- so `avgClosingLine` reads 2.50 and `edge` reads 0.00
 * no matter what happens, while the price behind that same 2.5 travels from -110 to -145. Reporting
 * only the line on a market like that is reporting that nothing happened when something did.
 *
 * The tests that matter here are about the *scale*: American odds cannot be averaged as numbers.
 */

const line = (
  bookKey: string,
  price: number | null,
  overrides: { includedInAverage?: boolean; liquidity?: number | null } = {}
) => ({
  bookKey,
  line: 2.5,
  price,
  includedInAverage: overrides.includedInAverage ?? true,
  liquidity: overrides.liquidity ?? null,
});

describe("averageClosingPrice", () => {
  it("averages in probability space, not in American odds", () => {
    // The whole point, in one case. -110 and +110 average numerically to 0, which is not a price at
    // all; their implied probabilities (0.5238 and 0.4762) average to exactly 0.5, which is +100.
    const { avg, avgProbability, count } = averageClosingPrice([
      line("fanduel", -110),
      line("draftkings", 110),
    ]);
    expect(avgProbability).toBeCloseTo(0.5, 6);
    expect(avg).toBe(100);
    expect(count).toBe(2);
  });

  it("returns the price itself when the field agrees on it", () => {
    const { avg } = averageClosingPrice([
      line("fanduel", -145),
      line("draftkings", -145),
      line("betmgm", -145),
    ]);
    expect(avg).toBe(-145);
  });

  it("lands on the right side of the even-money boundary", () => {
    // A shade worse than even money is a favourite's price, and a shade better is a dog's. Getting
    // this backwards flips the sign of every number the modal shows near the pick'em line.
    expect(americanFromProbability(0.51)).toBe(-104);
    expect(americanFromProbability(0.49)).toBe(104);
    // Exactly even money is +100 by convention; -100 is the same bet but nobody writes it that way.
    expect(americanFromProbability(0.5)).toBe(100);
    expect(americanFromProbability(0)).toBeNull();
    expect(americanFromProbability(1)).toBeNull();
  });

  it("ignores the books the line average already threw out", () => {
    // A stale quote that was excluded from the line must not come back in through the price -- the
    // two numbers describe the same field or they describe nothing.
    const { avg, count } = averageClosingPrice([
      line("fanduel", -110),
      line("draftkings", 110),
      line("fanatics", -950, { includedInAverage: false }),
    ]);
    expect(count).toBe(2);
    expect(avg).toBe(100);
  });

  it("skips books that quote the market but not this side", () => {
    // Normal and not a failure: a book hanging Over 21.5 is quoting the line to an Under bettor too,
    // so it counts toward the line average while having no price to contribute here.
    const { avg, count } = averageClosingPrice([
      line("fanduel", -110),
      line("draftkings", null),
      line("betmgm", 110),
    ]);
    expect(count).toBe(2);
    expect(avg).toBe(100);
  });

  it("has nothing to say when no book priced the side", () => {
    expect(averageClosingPrice([line("fanduel", null)])).toEqual({
      avg: null,
      avgProbability: null,
      count: 0,
    });
  });

  it("respects a configured book weight", () => {
    // Pinnacle at triple weight against one book at even money: 0.25 * 0.5238 + 0.75 * 0.4762.
    const { avgProbability } = averageClosingPrice(
      [line("draftkings", -110), line("pinnacle", 110)],
      { pinnacle: 3 }
    );
    expect(avgProbability).toBeCloseTo(0.25 * (110 / 210) + 0.75 * (100 / 210), 6);
  });
});

describe("buildClosingVerdict price reporting", () => {
  const FIXTURES = join(__dirname, "../../../../shared/src/__fixtures__");

  it("reports a price on a real captured market, over the same field as the line", () => {
    const plan = planScreenRead({
      sport: "NCAAF",
      statMarket: "Rushing Yards",
      marketType: "PLAYER_PROP",
    });
    if ("kind" in plan) throw new Error("expected a plannable read");

    const raw = JSON.parse(readFileSync(join(FIXTURES, "pp-screen-ncaaf-rushing-yards.json"), "utf8"));
    const parsed = normalizeScreenMarket(raw, plan);
    const row = findMatchingRow(parsed.rows, {
      marketType: "PLAYER_PROP",
      player: "Xavier Robinson",
      subjectTeam: null,
      matchup: null,
      statMarket: "Rushing Yards",
      side: "UNDER",
      externalPropId: null,
    });
    if (!row) throw new Error("expected the captured row to match");

    const verdict = buildClosingVerdict("PLAYER_PROP", "UNDER", 21.5, row, null, "PP_SCREEN");

    expect(verdict.avgClosingPrice).not.toBeNull();
    // A player prop's price sits somewhere near the pick'em line; anything outside this is a scale
    // mistake rather than a market.
    expect(Math.abs(verdict.avgClosingPrice as number)).toBeLessThan(400);
    // Every book that prices this side is a book that quotes the market, never the other way round.
    expect(verdict.closingPriceBookCount).toBeGreaterThan(0);
    expect(verdict.closingPriceBookCount).toBeLessThanOrEqual(verdict.closingBookCount);
    expect(verdict.avgClosingProbability).toBeCloseTo(
      verdict.avgClosingPrice !== null && verdict.avgClosingPrice > 0
        ? 100 / (verdict.avgClosingPrice + 100)
        : Math.abs(verdict.avgClosingPrice as number) / (Math.abs(verdict.avgClosingPrice as number) + 100),
      2
    );
  });

  it("says nothing about price on a column that quotes no line at all", () => {
    // A deliberate boundary, worth pinning down because it looks like a gap. The price average is
    // taken over exactly the books that are trusted for the LINE average, and that test requires a
    // line -- so a price-only column contributes neither. That is the right trade: on the optimizer
    // the price-only columns are the DFS payout and the algo column (a flat -119 and a derived
    // -165.82), and admitting those as "the market price" would be worse than having no price.
    //
    // It costs nothing where this modal actually reads. On PropProfessor's odds screen essentially
    // every column carries a line, which is why the captured-market test above gets a price.
    const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 14, {
      rowIndex: 0,
      marketType: "PLAYER_PROP",
      player: "Aaron Rodgers",
      selectionName: null,
      subjectTeam: null,
      isLive: false,
      team: null,
      opponent: null,
      matchup: null,
      sport: "NFL",
      statMarket: "Passing Touchdowns",
      side: "OVER",
      takenLine: null,
      fairProbability: null,
      boardEvPercent: null,
      gameStartTimeText: null,
      gameStartTimeIso: null,
      externalPropId: null,
      externalPlayerId: null,
      rawText: "",
      bookLines: [
        { bookKey: "fanduel", label: "FanDuel", line: null, price: -145, logoUrl: null, rawText: "" },
        { bookKey: "draftkings", label: "DraftKings", line: null, price: -135, logoUrl: null, rawText: "" },
      ],
    });

    expect(verdict.status).toBe("UNAVAILABLE");
    expect(verdict.avgClosingLine).toBeNull();
    expect(verdict.avgClosingPrice).toBeNull();
  });
});
