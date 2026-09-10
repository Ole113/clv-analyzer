import type { MarketType, Side } from "./constants";

export interface LineLike {
  bookKey: string;
  line: number | null;
  includedInAverage: boolean;
}

/**
 * Average of the closing lines across the real sportsbooks that were still quoting the prop.
 * Returns null when no book qualified -- callers must treat that as UNAVAILABLE rather than 0.
 *
 * `weights`, when given, turns this into a weighted mean: a book with a configured weight counts
 * that many times as much as a book at the default weight of 1, so an unweighted book is not
 * ignored -- it is just averaged in at the same footing as every other unweighted book. Passing no
 * weights (the default) is a plain mean, unchanged from before this option existed.
 */
export function averageClosingLine(
  lines: LineLike[],
  weights?: Record<string, number> | null,
  defaultWeight = 1
): { avg: number | null; count: number } {
  const usable = lines.filter((l) => l.includedInAverage && typeof l.line === "number");
  if (usable.length === 0) return { avg: null, count: 0 };
  if (!weights) {
    const sum = usable.reduce((acc, l) => acc + (l.line as number), 0);
    return { avg: sum / usable.length, count: usable.length };
  }
  let weightedSum = 0;
  let weightTotal = 0;
  for (const l of usable) {
    const w = weights[l.bookKey] ?? defaultWeight;
    weightedSum += (l.line as number) * w;
    weightTotal += w;
  }
  // Every configured weight at 0 (or negative) leaves nothing to divide by -- fall back to a
  // plain mean rather than reporting a bogus average or dividing by zero.
  if (weightTotal <= 0) {
    const sum = usable.reduce((acc, l) => acc + (l.line as number), 0);
    return { avg: sum / usable.length, count: usable.length };
  }
  return { avg: weightedSum / weightTotal, count: usable.length };
}

/**
 * Which side of the market a movement has to go for the bettor to have beaten the close.
 *
 * Totals and player props share a direction: an Over beats the close when the number moves UP,
 * because the bettor needed fewer than the market later demanded.
 *
 * Spreads run the OTHER WAY, and getting this backwards would silently invert a whole category of
 * results. Taking Seahawks +5.5 and seeing it close at +3.5 means the bettor holds more points
 * than the market ended up offering, so they beat the close: edge = taken - close. The same
 * formula reads correctly for a favourite, where -4.5 closing at -3.5 is a worse number to hold
 * (edge = -4.5 - -3.5 = -1).
 *
 * Moneylines use the same taken - close formula as spreads, over the raw American-odds price
 * rather than a point number. A favourite's price is negative and a dog's is positive, exactly
 * like a spread's signed line, and the same reasoning holds in both directions: -150 closing at
 * -165 means the market later demanded more to back the favourite than the bettor laid, a better
 * number held (edge = -150 - -165 = +15); +130 closing at +115 means later bettors got paid less
 * to take the dog, again a better number held (edge = 130 - 115 = +15).
 */
export function computeClv(
  marketType: MarketType,
  side: Side | null,
  takenLine: number,
  avgClosingLine: number
): { edge: number; beatClv: boolean } {
  const raw =
    marketType === "SPREAD" || marketType === "MONEYLINE"
      ? takenLine - avgClosingLine
      : side === "UNDER"
        ? takenLine - avgClosingLine
        : avgClosingLine - takenLine;
  const rounded = Math.round(raw * 1e6) / 1e6;
  // A perfectly flat line is not a win: no edge was gained, so beatClv is false at edge === 0.
  return { edge: rounded, beatClv: rounded > 0 };
}
