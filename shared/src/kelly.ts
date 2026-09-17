import { impliedProbability } from "./devig";

/**
 * Kelly staking from a price you can see and a fair price you supply yourself.
 *
 * The boards already say a line is off the market; none of them say how much to put on it. The
 * input here is deliberately the thing a human actually notices -- "Fliff is -110 and everyone else
 * is -140, that's 30 points" -- rather than a probability, because a probability is not what anyone
 * reads off a board.
 *
 * Lives in `shared/` rather than beside `evPercent` in the server's `ev.ts` for a dependency reason,
 * not a taste one: this runs inside a content script on OddsJam as well as on the dashboard, and a
 * content script can import `@clv/shared` but cannot import from `server/`. The same call
 * `devig.ts` makes, for the same reason. `server/src/lib/ev.ts` re-exports `decimalFromAmerican`
 * from here so there is still one place to look for the American-odds conversions.
 *
 * **The fair price is taken at face value.** With only one side quoted there is no second side to
 * de-vig against, so an entered -140 means exactly "58.3% to win". If that -140 is itself a vigged
 * consensus price then the EV below is optimistic by roughly half the hold, and both surfaces say
 * so in a footnote rather than silently correcting for a vig nobody stated.
 */

export interface KellyInput {
  /** American odds you are getting. */
  price: number;
  /** American odds you believe is fair for the same side. */
  fairPrice: number;
  bankroll: number;
  /** 1 = full Kelly, 0.25 = quarter Kelly. */
  multiplier: number;
  /** Dollars per unit. Non-positive means "1% of bankroll". */
  unitSize: number;
}

export interface KellyResult {
  /** Implied probability of `fairPrice`, taken as the true win probability. */
  fairProbability: number;
  /** Decimal payout of `price`, stake included. */
  decimal: number;
  /** Net decimal odds, `decimal - 1` -- the `b` in the Kelly formula. */
  b: number;
  /** EV as a percentage of stake, e.g. 11.36 for +11.36%. Unrounded -- rounding is the
   *  caller's business, and the `fullKellyFraction = evPercent/100 / b` identity below only holds
   *  exactly if this one is left alone. */
  evPercent: number;
  /** `(p*b - q) / b`, as a 0-1 fraction of bankroll. Never negative. */
  fullKellyFraction: number;
  /** `fullKellyFraction x multiplier`, clamped to [0, 1]. */
  fraction: number;
  stake: number;
  units: number;
  /** Signed odds-point gap: positive when `price` beats `fairPrice`. */
  points: number;
  /** Dollars per unit actually used, after the 1%-of-bankroll fallback. */
  unitSize: number;
}

/**
 * American odds projected onto a continuous line, so that "N points" means the same thing on both
 * sides of even money.
 *
 * American odds are not a number line: +100 and -100 are the same price, and the ladder runs
 * ... +120, +110, +100 / -100, -110, -120 ... with no gap at the crossover. Subtracting 30 from
 * +120 numerically gives +90, which is a *better* price, not a worse one. This maps the ladder onto
 * the reals with even money at zero -- +140 -> 40, +100 -> 0, -100 -> 0, -140 -> -40 -- so shifting
 * is plain arithmetic and crossing even money costs the 30 points a bettor would count.
 */
export function oddsAxis(price: number): number {
  return price > 0 ? price - 100 : 100 - Math.abs(price);
}

/** The inverse of `oddsAxis`. Even money (axis 0) comes back as +100. */
export function americanFromAxis(axis: number): number {
  return axis >= 0 ? 100 + axis : -(100 - axis);
}

/**
 * `price` moved `points` steps down the odds ladder.
 *
 * Positive `points` means *more expensive* -- the direction a fair price sits when the price you
 * are getting is the good one. `shiftAmerican(-110, 30)` is -140; `shiftAmerican(+120, 30)` is -110.
 */
export function shiftAmerican(price: number, points: number): number {
  if (!Number.isFinite(price) || price === 0 || !Number.isFinite(points)) return price;
  return Math.round(americanFromAxis(oddsAxis(price) - points));
}

/** How many points better than `fairPrice` the price you are getting is. The inverse of `shiftAmerican`. */
export function pointsBetween(price: number, fairPrice: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(fairPrice)) return 0;
  return Math.round(oddsAxis(price) - oddsAxis(fairPrice));
}

/** American odds as a decimal payout, stake included. Null rather than a guess on a non-price. */
export function decimalFromAmerican(price: number): number | null {
  if (!Number.isFinite(price) || price === 0) return null;
  return price > 0 ? 1 + price / 100 : 1 + 100 / Math.abs(price);
}

/**
 * The whole sum, or null when an input cannot support one.
 *
 * Null rather than NaN on bad input, the same contract `evaluateBoost` has: a half-typed field is
 * the normal state of a form, and a NaN leaking into the render is how "$NaN" ends up on screen.
 *
 * `fullKellyFraction` is floored at zero. A negative Kelly fraction is the instruction to bet the
 * *other* side, which is not a thing either surface can offer -- the other side is at a different
 * book at a different price -- so a -EV price answers "stake nothing" instead of a negative stake.
 */
export function evaluateKelly(input: KellyInput): KellyResult | null {
  const { price, fairPrice, bankroll, multiplier } = input;
  if (!Number.isFinite(bankroll) || bankroll <= 0) return null;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;

  const decimal = decimalFromAmerican(price);
  const fairDecimal = decimalFromAmerican(fairPrice);
  if (decimal === null || fairDecimal === null) return null;

  const p = impliedProbability(fairPrice);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;

  const b = decimal - 1;
  if (b <= 0) return null;
  const q = 1 - p;

  // Kelly is `(p*b - q) / b`, which is also `EV / b` -- the edge per dollar risked, divided by the
  // price of risking it. Both forms are here because the second is the one that makes the number
  // legible: at -110 with a 30-point edge, +11.36% EV over 0.909 is 12.5% of bankroll.
  const evPercent = (p * decimal - 1) * 100;
  const fullKellyFraction = Math.max(0, (p * b - q) / b);
  const fraction = Math.min(1, fullKellyFraction * multiplier);

  const unitSize =
    Number.isFinite(input.unitSize) && input.unitSize > 0
      ? input.unitSize
      : bankroll * DEFAULT_UNIT_FRACTION;
  const stake = fraction * bankroll;

  return {
    fairProbability: p,
    decimal,
    b,
    evPercent,
    fullKellyFraction,
    fraction,
    stake,
    units: unitSize > 0 ? stake / unitSize : 0,
    points: pointsBetween(price, fairPrice),
    unitSize,
  };
}

/** Quarter Kelly: the usual compromise between growth and the variance full Kelly actually carries. */
export const DEFAULT_KELLY_MULTIPLIER = 0.25;

/** A unit is 1% of bankroll unless a dollar figure is set. */
export const DEFAULT_UNIT_FRACTION = 0.01;

/**
 * The OddsJam boards that quote real American odds, and so are the ones worth a Kelly stake.
 *
 * An allowlist rather than a denylist: Kelly needs a two-sided price, and the pick'em boards
 * (PrizePicks, Underdog, Sleeper) quote a fixed payout instead, where "30 points off fair" is not a
 * quantity that exists. These are the slugs as they appear in `/fantasy-odds/<slug>`; the real list
 * is the one on the dashboard's Settings page, which both surfaces read, and this is what they fall
 * back to before it has been fetched.
 */
export const DEFAULT_KELLY_BOARDS = [
  "fliff",
  "rebet",
  "courtside",
  "betr",
  "dogg-house",
  "bracco",
  "prophet-x",
  "novig",
  "sportzino",
];

/** Presets worth one click, since a multiplier is almost never typed as an arbitrary number. */
export const KELLY_PRESETS: { label: string; value: number }[] = [
  { label: "Full", value: 1 },
  { label: "Half", value: 0.5 },
  { label: "Quarter", value: 0.25 },
  { label: "Eighth", value: 0.125 },
];
