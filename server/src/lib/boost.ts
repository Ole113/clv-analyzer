import { decimalFromAmerican } from "./ev";

/**
 * Is a profit boost worth using on a pick'em slip?
 *
 * A boost lifts the *profit* of a slip, not its payout, so its effect on the break-even win rate
 * depends on the leg count and -- on Underdog Flex -- on a whole table of partial-win payouts.
 * That makes it impossible to eyeball: a 3-leg at -122/leg needs 55.0% a leg, but with a 25% boost
 * it needs only 51.6%, and the Flex answer is a binomial sum rather than a single multiplier.
 */

/** One settlement outcome: hit `correct` of the legs, get paid `multiplier` per $1 (stake included). */
export interface PayoutTier {
  correct: number;
  multiplier: number;
}

export type BoostMode = "power" | "flex";

export interface BoostInput {
  /** American price of a single leg, e.g. -122. Sets the Power payout; informational for Flex. */
  legPrice: number;
  /** True win probability of each leg, 0-1. Length is the leg count. */
  legProbs: number[];
  /** Profit boost in percent: 25 means the profit is multiplied by 1.25. */
  boostPct: number;
  mode: BoostMode;
  /** Payout table for Flex. Ignored in Power mode. */
  flexTiers?: PayoutTier[];
}

export interface BoostTierResult {
  correct: number;
  probability: number;
  base: number;
  boosted: number;
  /** probability x boosted -- what this outcome contributes to the gross return. */
  contribution: number;
}

export interface BoostResult {
  tiers: BoostTierResult[];
  /** Probability every leg lands. */
  hitProbability: number;
  /** EV as a percentage of stake, e.g. 14.7 for +14.7%. */
  evPercent: number;
  /** Win rate each leg needs, with the boost applied. */
  breakevenLegProb: number;
  /** The same, with no boost -- the number the slip is normally quoted at. */
  breakevenLegProbNoBoost: number;
  /** `breakevenLegProb` as an American price, for checking against the slip. */
  breakevenAmerican: number;
  /** Smallest boost that makes the slip +EV; 0 when it already is, null when no boost can. */
  minBoostPct: number | null;
}

/**
 * A profit boost scales profit, so it leaves the stake alone: 7.2x pays 6.2x profit, and a 25%
 * boost makes that 7.75x profit, i.e. 8.75x back.
 *
 * Tiers that pay under 1.0x -- Underdog's 3/5 at 0.4x, say -- are a net loss on the slip, and a
 * profit boost never amplifies a loss, so they pass through untouched.
 */
export function boostedMultiplier(base: number, boostPct: number): number {
  if (!Number.isFinite(base) || base <= 1) return base;
  return 1 + (base - 1) * (1 + boostPct / 100);
}

/**
 * Probability of exactly k successes across independent trials with *different* probabilities
 * (a Poisson binomial). Index k of the result is P(exactly k). The textbook C(n,k)p^k q^(n-k)
 * only holds when every leg is the same price, which a real slip rarely is.
 */
export function poissonBinomial(probs: number[]): number[] {
  let dist = [1];
  for (const p of probs) {
    const next = new Array<number>(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      next[k] += dist[k] * (1 - p);
      next[k + 1] += dist[k] * p;
    }
    dist = next;
  }
  return dist;
}

/** Inverse of `impliedProbability` in ./ev -- a win rate expressed as an American price. */
export function americanFromProbability(prob: number): number {
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return NaN;
  const value = prob >= 0.5 ? -(100 * prob) / (1 - prob) : (100 * (1 - prob)) / prob;
  return Math.round(value * 10) / 10;
}

/** The payout table a slip settles against: one all-or-nothing tier for Power, the table for Flex. */
export function tiersFor(input: BoostInput): PayoutTier[] {
  const legs = input.legProbs.length;
  if (input.mode === "flex") {
    return (input.flexTiers ?? [])
      .filter((t) => Number.isFinite(t.multiplier) && t.correct >= 0 && t.correct <= legs)
      .slice()
      .sort((a, b) => b.correct - a.correct);
  }
  const decimal = decimalFromAmerican(input.legPrice);
  if (decimal === null) return [];
  return [{ correct: legs, multiplier: decimal ** legs }];
}

/** Gross return per $1 staked: the probability-weighted payout across every outcome. */
function grossReturn(dist: number[], tiers: PayoutTier[], boostPct: number): number {
  let total = 0;
  for (const tier of tiers) {
    const p = dist[tier.correct] ?? 0;
    total += p * boostedMultiplier(tier.multiplier, boostPct);
  }
  return total;
}

/** EV per $1 staked (0.147 = +14.7%) for a uniform per-leg win rate. */
function evAtUniformProb(prob: number, legs: number, tiers: PayoutTier[], boostPct: number): number {
  const dist = poissonBinomial(new Array<number>(legs).fill(prob));
  return grossReturn(dist, tiers, boostPct) - 1;
}

/**
 * The per-leg win rate at which the slip breaks even.
 *
 * Bisection rather than algebra: once Flex tiers are in play the EV is a polynomial in p with no
 * usable closed form. EV is monotonic in p for any sane payout table, so bisection is exact enough.
 */
function breakevenProb(legs: number, tiers: PayoutTier[], boostPct: number): number {
  if (legs <= 0 || tiers.length === 0) return NaN;
  if (evAtUniformProb(1, legs, tiers, boostPct) <= 0) return NaN; // even a perfect slip loses
  if (evAtUniformProb(0, legs, tiers, boostPct) >= 0) return 0; // free money at any win rate
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (evAtUniformProb(mid, legs, tiers, boostPct) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The smallest boost that turns the slip +EV.
 *
 * Every boosted tier is linear in the boost and the rest are constant, so EV is affine in it: two
 * evaluations pin the line down and the root comes out exactly, with no search.
 */
function minBoostFor(dist: number[], tiers: PayoutTier[]): number | null {
  const at0 = grossReturn(dist, tiers, 0) - 1;
  if (at0 >= 0) return 0;
  const at100 = grossReturn(dist, tiers, 100) - 1;
  const slope = (at100 - at0) / 100;
  if (slope <= 0) return null; // nothing to boost -- every tier is at or below stake
  return -at0 / slope;
}

export function evaluateBoost(input: BoostInput): BoostResult | null {
  const legs = input.legProbs.length;
  const tiers = tiersFor(input);
  if (legs === 0 || tiers.length === 0) return null;
  if (input.legProbs.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) return null;
  if (!Number.isFinite(input.boostPct)) return null;

  const dist = poissonBinomial(input.legProbs);
  const boostPct = input.boostPct;

  const tierResults: BoostTierResult[] = tiers.map((tier) => {
    const probability = dist[tier.correct] ?? 0;
    const boosted = boostedMultiplier(tier.multiplier, boostPct);
    return {
      correct: tier.correct,
      probability,
      base: tier.multiplier,
      boosted,
      contribution: probability * boosted,
    };
  });

  const breakevenLegProb = breakevenProb(legs, tiers, boostPct);

  return {
    tiers: tierResults,
    hitProbability: dist[legs] ?? 0,
    evPercent: (grossReturn(dist, tiers, boostPct) - 1) * 100,
    breakevenLegProb,
    breakevenLegProbNoBoost: breakevenProb(legs, tiers, 0),
    breakevenAmerican: americanFromProbability(breakevenLegProb),
    minBoostPct: minBoostFor(dist, tiers),
  };
}

/**
 * Underdog's Flex payouts as of this writing. They get re-tuned, so the screen renders these as
 * editable inputs -- they are a starting point to check against the slip, not a constant.
 */
export const DEFAULT_FLEX_TIERS: Record<number, PayoutTier[]> = {
  3: [
    { correct: 3, multiplier: 2.25 },
    { correct: 2, multiplier: 1.25 },
  ],
  4: [
    { correct: 4, multiplier: 7.2 },
    { correct: 3, multiplier: 1.8 },
  ],
  5: [
    { correct: 5, multiplier: 20 },
    { correct: 4, multiplier: 2 },
    { correct: 3, multiplier: 0.4 },
  ],
  6: [
    { correct: 6, multiplier: 37.5 },
    { correct: 5, multiplier: 2.5 },
    { correct: 4, multiplier: 0.5 },
  ],
};

/** Falls back to an all-or-nothing table so an unlisted leg count still renders something sane. */
export function defaultFlexTiers(legs: number): PayoutTier[] {
  const known = DEFAULT_FLEX_TIERS[legs];
  if (known) return known.map((t) => ({ ...t }));
  return [{ correct: legs, multiplier: 2 }];
}
