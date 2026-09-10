/**
 * Turning a two-sided quote into a fair (no-vig) probability.
 *
 * Lives in `shared` rather than beside `averageClosingLine` in the server's `clv.ts` for a
 * dependency reason, not a taste one: the closing rows are built in
 * `sources/propprofessor-screen.ts`, which is shared code the server imports, so anything that
 * runs *while building a row* cannot live server-side. The server re-exports these from `clv.ts`
 * so there is still one place to look for closing-average arithmetic.
 */

/** American odds as a 0-1 probability, vig included. */
export function impliedProbability(price: number): number {
  return price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
}

/**
 * The fair probability of one side of a two-way market, with the book's margin removed.
 *
 * Multiplicative de-vig: the two raw implied probabilities sum to more than 1 (that excess is the
 * hold), and each side is scaled down by the same factor -- `p_fair = p_raw / (p1 + p2)`. It is the
 * same quantity `impliedProbability` computes per side, just renormalised so the pair sums to 1.
 *
 * This is the simplest of the standard methods and it distributes the vig proportionally, which
 * slightly overstates a longshot's chance under favourite-longshot bias. Shin's method corrects for
 * that but needs an iterative solve; it would be a drop-in replacement behind this signature, which
 * is why the signature takes the raw prices rather than pre-computed probabilities.
 *
 * Returns null rather than a guess when either side is missing or the pair is degenerate -- a book
 * quoting only one side has no margin to remove, and pretending otherwise would report the vig
 * itself as the fair price.
 */
export function devigTwoWay(price: number | null, otherPrice: number | null): number | null {
  if (price === null || otherPrice === null) return null;
  if (!Number.isFinite(price) || !Number.isFinite(otherPrice)) return null;
  if (price === 0 || otherPrice === 0) return null;

  const raw = impliedProbability(price);
  const rawOther = impliedProbability(otherPrice);
  const total = raw + rawOther;
  // An overround below 1 means the pair is arbitrageable -- possible across two books, not within
  // one, so it means the quote is stale or mis-paired rather than that we have found free money.
  if (!Number.isFinite(total) || total <= 0) return null;

  const fair = raw / total;
  return fair > 0 && fair < 1 ? Math.round(fair * 1e6) / 1e6 : null;
}

/**
 * Consensus fair probability across the books that quoted both sides.
 *
 * Deliberately the same shape as `averageClosingLine`: an optional weight map, a default weight of
 * 1 for books that have none, and a fall back to a plain mean when the weights leave nothing to
 * divide by. Books that quoted only one side simply do not appear -- they contribute a line to the
 * closing average but have no de-vigged number to contribute here, so the two averages are over
 * different (nested) samples and `count` is reported so that is visible.
 */
export function averageClosingProbability(
  probabilities: { bookKey: string; fairProbability: number | null }[],
  weights?: Record<string, number> | null,
  defaultWeight = 1
): { avg: number | null; count: number } {
  const usable = probabilities.filter(
    (p): p is { bookKey: string; fairProbability: number } =>
      typeof p.fairProbability === "number" && Number.isFinite(p.fairProbability)
  );
  if (usable.length === 0) return { avg: null, count: 0 };

  const plain = () => usable.reduce((sum, p) => sum + p.fairProbability, 0) / usable.length;
  const round = (v: number) => Math.round(v * 1e6) / 1e6;

  if (!weights) return { avg: round(plain()), count: usable.length };

  let weightedSum = 0;
  let weightTotal = 0;
  for (const p of usable) {
    const w = weights[p.bookKey] ?? defaultWeight;
    weightedSum += p.fairProbability * w;
    weightTotal += w;
  }
  if (weightTotal <= 0) return { avg: round(plain()), count: usable.length };
  return { avg: round(weightedSum / weightTotal), count: usable.length };
}
