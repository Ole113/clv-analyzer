import { describe, expect, it } from "vitest";
import {
  americanFromProbability,
  boostedMultiplier,
  defaultFlexTiers,
  evaluateBoost,
  poissonBinomial,
  type BoostInput,
} from "../boost";

const power = (legs: number, prob: number, boostPct: number, legPrice = -122): BoostInput => ({
  legPrice,
  legProbs: new Array<number>(legs).fill(prob),
  boostPct,
  mode: "power",
});

const flex = (legs: number, prob: number, boostPct: number, legPrice = -107): BoostInput => ({
  legPrice,
  legProbs: new Array<number>(legs).fill(prob),
  boostPct,
  mode: "flex",
  flexTiers: defaultFlexTiers(legs),
});

describe("poissonBinomial", () => {
  it("matches the binomial formula when every leg is the same price", () => {
    const dist = poissonBinomial([0.6, 0.6, 0.6]);
    expect(dist[3]).toBeCloseTo(0.216, 10);
    expect(dist[2]).toBeCloseTo(3 * 0.36 * 0.4, 10);
    expect(dist[0]).toBeCloseTo(0.064, 10);
  });

  it("handles legs with different probabilities and still sums to 1", () => {
    const dist = poissonBinomial([0.52, 0.6, 0.45, 0.7]);
    expect(dist.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(dist[4]).toBeCloseTo(0.52 * 0.6 * 0.45 * 0.7, 12);
  });
});

describe("power plays", () => {
  it("puts break-even at the familiar 55% a leg for a 3-leg at -122", () => {
    const result = evaluateBoost(power(3, 0.54, 0))!;
    expect(result.breakevenLegProbNoBoost).toBeCloseTo(0.55, 3);
    expect(result.evPercent).toBeLessThan(0); // 54% legs are a loser at this price
  });

  it("flips three 54% props to +EV with a 25% boost", () => {
    const result = evaluateBoost(power(3, 0.54, 25))!;
    expect(result.hitProbability).toBeCloseTo(0.157464, 6);
    expect(result.evPercent).toBeCloseTo(14.7, 1);
    expect(result.breakevenLegProb).toBeCloseTo(0.516, 3);
    expect(result.breakevenLegProbNoBoost).toBeCloseTo(0.55, 3);
  });

  it("boosts the profit and not the stake", () => {
    const result = evaluateBoost(power(3, 0.54, 25))!;
    const tier = result.tiers[0];
    expect(tier.base).toBeCloseTo(6.03, 2);
    expect(tier.boosted).toBeCloseTo(1 + (tier.base - 1) * 1.25, 10);
  });
});

describe("underdog flex", () => {
  it("prices the default 4-leg table at the -107 a leg the slip quotes", () => {
    const result = evaluateBoost(flex(4, 0.52, 0))!;
    expect(result.breakevenLegProbNoBoost).toBeCloseTo(0.5179, 3);
    expect(Math.round(americanFromProbability(result.breakevenLegProbNoBoost))).toBe(-107);
  });

  it("boosts every winning tier, not just the top one", () => {
    const result = evaluateBoost(flex(4, 0.54, 25))!;
    const top = result.tiers.find((t) => t.correct === 4)!;
    const partial = result.tiers.find((t) => t.correct === 3)!;
    expect(top.boosted).toBeCloseTo(8.75, 10);
    expect(partial.boosted).toBeCloseTo(2.0, 10);
    expect(result.evPercent).toBeGreaterThan(0);
  });

  it("leaves a losing tier alone -- a profit boost never amplifies a loss", () => {
    const result = evaluateBoost(flex(5, 0.54, 25))!;
    const refund = result.tiers.find((t) => t.correct === 3)!;
    expect(refund.base).toBeCloseTo(0.4, 10);
    expect(refund.boosted).toBeCloseTo(0.4, 10);
    expect(boostedMultiplier(0.4, 25)).toBeCloseTo(0.4, 10);
  });

  it("weights the partial-win tier, so flex beats power at the same leg count", () => {
    const flexResult = evaluateBoost(flex(4, 0.5, 0))!;
    expect(flexResult.tiers.map((t) => t.correct)).toEqual([4, 3]);
    expect(flexResult.tiers.reduce((a, t) => a + t.contribution, 0)).toBeCloseTo(
      flexResult.evPercent / 100 + 1,
      10
    );
  });
});

describe("minimum boost", () => {
  it("reports 0 when the slip is already +EV", () => {
    expect(evaluateBoost(power(3, 0.6, 0))!.minBoostPct).toBe(0);
  });

  it("returns the boost that lands exactly on break-even", () => {
    const needed = evaluateBoost(power(3, 0.54, 0))!.minBoostPct!;
    expect(needed).toBeGreaterThan(0);
    expect(evaluateBoost(power(3, 0.54, needed))!.evPercent).toBeCloseTo(0, 8);
  });

  it("round-trips on flex too", () => {
    const needed = evaluateBoost(flex(4, 0.5, 0))!.minBoostPct!;
    expect(evaluateBoost(flex(4, 0.5, needed))!.evPercent).toBeCloseTo(0, 8);
  });
});

describe("guard rails", () => {
  it("rejects an unusable price rather than returning NaN", () => {
    expect(evaluateBoost(power(3, 0.54, 25, 0))).toBeNull();
  });

  it("rejects out-of-range leg probabilities", () => {
    expect(evaluateBoost({ ...power(3, 0.54, 25), legProbs: [0.5, 1.4, 0.5] })).toBeNull();
  });

  it("converts probabilities back to American prices on both sides of even", () => {
    expect(americanFromProbability(0.55)).toBeCloseTo(-122.2, 1);
    expect(americanFromProbability(0.45)).toBeCloseTo(122.2, 1);
  });
});
