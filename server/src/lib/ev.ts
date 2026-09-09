import { isFantasyBook, type BookLine } from "@clv/shared";

/**
 * True expected value, in percent of stake.
 *
 * The fair (no-vig) win probability comes from the site's own market column -- OddsJam's
 * "% CHANCE TO HIT", PropProfessor's "Value" -- which is already de-vigged and, crucially, is
 * quoted at the exact line taken. Deriving it from the raw book cells is not possible from what
 * the boards render: they show one price per book at that book's own line, so there is no second
 * side to de-vig against and no way to re-price a 62.5 pick from a book hanging 90.5.
 *
 * EV% = fair probability x decimal payout - 1.
 */

export function decimalFromAmerican(price: number): number | null {
  if (!Number.isFinite(price) || price === 0) return null;
  return price > 0 ? 1 + price / 100 : 1 + 100 / Math.abs(price);
}

/** The pick'em payout price for a leg, taken from the DFS column when the board shows one. */
export function fantasyPriceFrom(bookLines: BookLine[]): number | null {
  for (const b of bookLines) {
    if (b.price === null) continue;
    if (isFantasyBook(b.bookKey, b.label)) return b.price;
  }
  return null;
}

export const DEFAULT_PICKEM_PRICE = Number(process.env.DEFAULT_PICKEM_PRICE ?? -119);

/**
 * Returns EV as a percentage (e.g. 4.2 for +4.2%), or null when the inputs are missing rather
 * than substituting a guess.
 */
export function evPercent(
  fairProbability: number | null,
  price: number | null
): number | null {
  if (fairProbability === null || fairProbability <= 0 || fairProbability >= 1) return null;
  const effective = price ?? DEFAULT_PICKEM_PRICE;
  const decimal = decimalFromAmerican(effective);
  if (decimal === null) return null;
  return Math.round((fairProbability * decimal - 1) * 1000) / 10;
}

/**
 * How favourable a book's closing number was, relative to the consensus close.
 *
 * For an Over the bettor wants a LOWER number (fewer needed); for an Under, higher. Positive means
 * the book's number was friendlier than consensus, negative means it was worse.
 */
export function bookFavorability(
  side: "OVER" | "UNDER",
  bookLine: number,
  consensus: number
): number {
  const delta = side === "OVER" ? consensus - bookLine : bookLine - consensus;
  return Math.round(delta * 1000) / 1000;
}
