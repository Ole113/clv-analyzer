import { isExchange } from "@clv/shared";
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** American odds as a 0-1 probability, vig included. */
function impliedProbability(price: number): number {
  return price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
}

/**
 * Books whose number is too far from the rest of the field to be believed.
 *
 * Needed because the odds screen lists every book that has *any* number up, including ones that are
 * stale, mis-mapped, or -- on an exchange -- just one person's bad resting order. A single such
 * quote moves the closing average a long way. Observed on a real captured market: for Xavier
 * Robinson's rushing yards, seven books cluster at 20.5-24.5 while Fanatics' entire ladder sits far
 * above (Over 19.5 at -950, where DraftKings has -144). Averaging Fanatics in pulls the close from
 * 22.6 to 25.9 and cuts the measured edge by more than half.
 *
 * Median absolute deviation rather than a mean/standard-deviation test, because the mean is exactly
 * what the outlier corrupts. The band has a floor so that a tight field (where MAD collapses to 0)
 * does not start rejecting ordinary half-point disagreement.
 *
 * Two things this gets right that a naive version does not:
 *
 * **Moneylines are compared as probabilities, not as American odds.** For a moneyline the tracked
 * "line" IS the price, and American odds are a terrible scale to do arithmetic on: they are
 * discontinuous at ±100 and wildly non-linear. -105 and +105 are nearly the same bet but sit 210
 * apart numerically, while -1000 and -5000 are 4000 apart and differ by four points of probability.
 * Measuring deviation in implied probability is the only way -1000 against a field of -150 reads as
 * the outlier it is, without also flagging every book that crosses the pick'em line.
 *
 * **Exchanges do not get to define the consensus.** Prices on Novig, Prophet X, Kalshi and
 * Polymarket are set by whoever has an order resting, so several of them being off-market at once
 * is not evidence that the market has moved. They are excluded from the reference median whenever
 * enough traditional books remain to form one, and are then held to a tighter tolerance.
 */
export function findLineOutliers(
  lines: LineLike[],
  marketType: MarketType = "PLAYER_PROP"
): Set<string> {
  const usable = lines.filter(
    (l): l is LineLike & { line: number } => l.includedInAverage && typeof l.line === "number"
  );
  // Below three there is nothing that could be called a field, and discarding a real quote is
  // worse than keeping a doubtful one.
  if (usable.length < 3) return new Set();

  const scale = (line: number) =>
    marketType === "MONEYLINE" ? impliedProbability(line) : line;

  const anchors = usable.filter((l) => !isExchange(l.bookKey));
  // Fall back to the whole field only when the traditional books are too few to speak for it.
  const reference = anchors.length >= 3 ? anchors : usable;

  const mid = median(reference.map((l) => scale(l.line)));
  const mad = median(reference.map((l) => Math.abs(scale(l.line) - mid)));

  // Probabilities live on 0-1, so the line-unit floor would swallow the entire scale.
  // The floor only bites when the field agrees almost exactly and MAD collapses toward zero; it is
  // kept modest so that it does not, in that case, widen the band past the point of catching
  // anything -- at 15% of the line a tight prop field tolerated a book five yards off the market.
  const floor = marketType === "MONEYLINE" ? 0.04 : Math.max(Math.abs(mid) * 0.1, 1);
  // 1.4826 rescales MAD to be comparable to a standard deviation for normal data.
  const band = Math.max(1.4826 * mad, floor);

  const outliers = new Set<string>();
  for (const l of usable) {
    const tolerance = (isExchange(l.bookKey) ? 2 : 3) * band;
    if (Math.abs(scale(l.line) - mid) > tolerance) outliers.add(l.bookKey);
  }

  // Never throw away the majority of the traditional books: if the test would reject half of them
  // or more, the field has no consensus to be an outlier from, and keeping everything is honest.
  // Exchange rejections are not protected by this -- an exchange disagreeing with the sportsbooks
  // is the case this exists to catch, not a sign that the sportsbooks are wrong.
  const rejectedAnchors = anchors.filter((l) => outliers.has(l.bookKey)).length;
  if (anchors.length > 0 && rejectedAnchors * 2 >= anchors.length) {
    for (const l of anchors) outliers.delete(l.bookKey);
  }
  return outliers;
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
