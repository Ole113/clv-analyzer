import { describe, expect, it } from "vitest";
import {
  DEFAULT_KELLY_BOARDS,
  DEFAULT_KELLY_MULTIPLIER,
  evaluateKelly,
  normalizeBookKey,
  oddsAxis,
  pointsBetween,
  shiftAmerican,
  type KellyInput,
} from "@clv/shared";

const bet = (price: number, points: number, over: Partial<KellyInput> = {}): KellyInput => ({
  price,
  fairPrice: shiftAmerican(price, points),
  bankroll: 5000,
  multiplier: 1,
  unitSize: 100,
  ...over,
});

describe("the odds ladder", () => {
  it("treats +100 and -100 as the same price", () => {
    expect(oddsAxis(100)).toBe(oddsAxis(-100));
  });

  it("moves -110 thirty points more expensive to -140", () => {
    expect(shiftAmerican(-110, 30)).toBe(-140);
  });

  it("counts the crossover, so +120 thirty points more expensive is -110", () => {
    expect(shiftAmerican(120, 30)).toBe(-110);
  });

  it("moves the other way too: -140 is thirty points cheaper at -110", () => {
    expect(shiftAmerican(-140, -30)).toBe(-110);
  });

  it("round trips through pointsBetween on both sides of even money", () => {
    for (const price of [-250, -140, -110, 100, 115, 300]) {
      for (const points of [-45, -10, 0, 25, 60]) {
        expect(pointsBetween(price, shiftAmerican(price, points))).toBe(points);
      }
    }
  });
});

describe("the -110 against a -140 market", () => {
  const result = evaluateKelly(bet(-110, 30))!;

  it("prices the fair side at 58.33%", () => {
    expect(result.fairProbability).toBeCloseTo(0.58333, 5);
  });

  it("is worth +11.36% of stake", () => {
    expect(result.evPercent).toBeCloseTo(11.36, 2);
  });

  it("is a 12.5% of bankroll bet at full Kelly", () => {
    expect(result.fullKellyFraction).toBeCloseTo(0.125, 6);
  });

  it("is $156.25, or 1.56 units, at quarter Kelly on $5,000", () => {
    const quarter = evaluateKelly(bet(-110, 30, { multiplier: DEFAULT_KELLY_MULTIPLIER }))!;
    expect(quarter.stake).toBeCloseTo(156.25, 2);
    expect(quarter.units).toBeCloseTo(1.5625, 4);
  });

  it("reports the discrepancy it was given", () => {
    expect(result.points).toBe(30);
  });
});

describe("the shape of the answer", () => {
  it("is EV divided by the net odds, whatever the price", () => {
    for (const [price, points] of [
      [-110, 30],
      [-250, 40],
      [140, 25],
      [100, 15],
    ] as const) {
      const r = evaluateKelly(bet(price, points))!;
      expect(r.fullKellyFraction).toBeCloseTo(r.evPercent / 100 / r.b, 8);
    }
  });

  it("scales linearly with the multiplier", () => {
    const full = evaluateKelly(bet(-110, 30))!;
    const eighth = evaluateKelly(bet(-110, 30, { multiplier: 0.125 }))!;
    expect(eighth.fraction).toBeCloseTo(full.fraction * 0.125, 8);
    expect(eighth.stake).toBeCloseTo(full.stake * 0.125, 6);
  });

  it("never stakes more than the bankroll, however big the edge", () => {
    const absurd = evaluateKelly(bet(400, 300, { multiplier: 1 }))!;
    expect(absurd.fraction).toBeLessThanOrEqual(1);
    expect(absurd.stake).toBeLessThanOrEqual(5000);
  });

  it("falls back to 1% of bankroll for a unit when none is set", () => {
    const r = evaluateKelly(bet(-110, 30, { unitSize: 0 }))!;
    expect(r.unitSize).toBe(50);
    expect(r.units).toBeCloseTo(r.stake / 50, 6);
  });

  it("says stake nothing on a price worse than fair, rather than a negative stake", () => {
    // -130 into a -110 market: the wrong side of the same discrepancy.
    const r = evaluateKelly(bet(-130, -20))!;
    expect(r.evPercent).toBeLessThan(0);
    expect(r.fullKellyFraction).toBe(0);
    expect(r.stake).toBe(0);
  });

  it("stakes nothing at a fair price, where the edge is exactly zero", () => {
    const r = evaluateKelly(bet(-110, 0))!;
    expect(r.evPercent).toBeCloseTo(0, 6);
    expect(r.stake).toBeCloseTo(0, 6);
  });
});

describe("the default board list", () => {
  it("is the boards that quote real American odds", () => {
    expect(DEFAULT_KELLY_BOARDS).toEqual([
      "fliff",
      "rebet",
      "courtside",
      "betr",
      "dogg-house",
      "bracco",
      "prophet-x",
      "novig",
      "sportzino",
    ]);
  });

  it("has no two entries that normalize to the same board", () => {
    // The gate matches on the normalized key, so "prophet-x" and "prophetx" would be one board
    // listed twice rather than two boards -- a typo that would otherwise go unnoticed.
    const keys = DEFAULT_KELLY_BOARDS.map((b) => normalizeBookKey(b));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(null);
  });

  it("lists no pick'em board, where a discrepancy from fair does not exist", () => {
    for (const pickem of ["prizepicks", "underdog", "sleeper", "dabble"]) {
      expect(DEFAULT_KELLY_BOARDS).not.toContain(pickem);
    }
  });
});

describe("guard rails", () => {
  it("returns null rather than NaN on a half-typed form", () => {
    expect(evaluateKelly(bet(-110, 30, { price: Number.NaN }))).toBeNull();
    expect(evaluateKelly(bet(-110, 30, { fairPrice: Number.NaN }))).toBeNull();
    expect(evaluateKelly(bet(-110, 30, { bankroll: Number.NaN }))).toBeNull();
  });

  it("returns null on a price of zero, which is not a price", () => {
    expect(evaluateKelly(bet(-110, 30, { price: 0 }))).toBeNull();
    expect(evaluateKelly(bet(-110, 30, { fairPrice: 0 }))).toBeNull();
  });

  it("returns null without a bankroll or a multiplier to stake it by", () => {
    expect(evaluateKelly(bet(-110, 30, { bankroll: 0 }))).toBeNull();
    expect(evaluateKelly(bet(-110, 30, { multiplier: 0 }))).toBeNull();
    expect(evaluateKelly(bet(-110, 30, { bankroll: -100 }))).toBeNull();
  });
});
