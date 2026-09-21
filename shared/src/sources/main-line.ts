/**
 * Which line each book is really quoting, given every selection it was seen quoting.
 *
 * ## Why this is its own module
 *
 * This rule was written for PropProfessor's odds screen and lived inside its parser. The Odds API
 * then arrived as a second source answering the same question, and the two are only worth showing
 * side by side in one modal if they cannot disagree about *method* -- if tab 1 says the field is on
 * 14.5 and tab 2 says 15.5 because each reconstructed "this book's line" differently, the
 * comparison is worse than useless: it looks like a disagreement between sportsbooks when it is
 * actually a disagreement between two of our own parsers.
 *
 * So the rule lives here once, and both sources hand it their quotes. The shapes they start from
 * are completely different -- the screen ships a `selections` object keyed by line, The Odds API
 * ships a flat `outcomes` array per bookmaker -- but by the time either has been flattened into
 * `BookQuote[]` the question is identical, and from there so is the answer.
 *
 * ## The rule
 *
 * A book's main line is, first, whichever line the *majority of books* are quoting -- the real
 * consensus number -- if this book quotes that line at all. "Least lopsided" is only the
 * tie-breaker for books that don't: a book hanging Over 9.5 at -400 is not quoting 9.5 as its
 * number, it is selling a near-certainty, so among a book's *other* selections the more balanced
 * one is the better guess at its real line. Picking least-lopsided globally, before checking for a
 * consensus line, has a real failure mode -- a book can quote the correct, consensus line at a
 * perfectly normal but not perfectly balanced price (say -105/-115) while also hanging some
 * unrelated deep alt line dead even (-110/-110); "most balanced wins" would pick the alt line and
 * silently throw away a book that was quoting the real market all along. Preferring the consensus
 * line whenever a book has it avoids that.
 */

import { impliedProbability } from "../devig";

/**
 * How near even money a quote has to be, in implied probability, to read as a real market rather
 * than a stray order. 0.2 is roughly -400/+400 -- comfortably wider than any main line on a player
 * prop, so this only ever fires on quotes that were never a serious price.
 */
export const NEAR_MARKET_MIN_PROB = 0.2;

/** One (book, selection) pair, already flattened out of whatever shape the source ships. */
export interface BookQuote {
  /** Groups a book's selections together. Whatever the source keys its books by. */
  bookKey: string;
  /** Human label for the book, as the source spells it. */
  label: string;
  /** The line this selection quotes for the side being read. Null when the source states none. */
  line: number | null;
  /** The taken side's American price here. Null is normal and not disqualifying. */
  price: number | null;
  /** The opposite side's price at this same selection, where the source exposes it. */
  otherSidePrice: number | null;
  /** Money resting behind the quote, where the source reports depth. */
  liquidity: number | null;
}

export interface BookMainLine {
  label: string;
  line: number | null;
  /** The taken side's price where the book quotes it. Null is normal and not disqualifying. */
  price: number | null;
  /**
   * The opposite side's price at the same selection. Already needed to decide which selection is
   * this book's main line; kept rather than discarded because it is the second half a de-vig needs,
   * and on a source that publishes no fair probability of its own it is the only place a de-vigged
   * closing probability can come from.
   */
  otherSidePrice: number | null;
  /**
   * Money resting behind the chosen selection, when the source reports any. Almost always 0 or null
   * on a traditional sportsbook (they do not publish depth); real numbers come from the exchanges
   * and from Pinnacle, which is exactly where a size-weighted average is worth having.
   */
  liquidity: number | null;
  /** False when even this book's best selection is priced nowhere near a real market. */
  nearMarket: boolean;
  /** Every distinct line this book was seen quoting, so alt-line collapsing stays auditable. */
  selectionsSeen: number[];
  /**
   * The taken side's price at the line the caller asked about, when this book quotes that line.
   *
   * Independent of `line`/`price` above, which stay the book's own main number: a book on 14.5 that
   * also hangs 15.5 contributes both, and neither displaces the other.
   */
  priceAtLine: number | null;
}

/**
 * Rebuilds each book's own main line across a flat list of quotes.
 *
 * `atLine` asks each book, additionally, what it pays at one specific line. It is answered off the
 * same candidate list rather than in a second pass, since every selection a book quotes is already
 * here -- which is the whole reason an alt line can be answered at all.
 */
export function pickMainLines(
  quotes: BookQuote[],
  atLine: number | null = null
): Map<string, BookMainLine> {
  type Candidate = BookQuote & { nearMarket: boolean; lopsidedness: number };

  const candidatesByBook = new Map<string, Candidate[]>();
  // How many distinct books quote each line at all, to find the real consensus number rather than
  // just whichever selection happens to price closest to even money.
  const bookCountByLine = new Map<number, Set<string>>();

  for (const quote of quotes) {
    if (quote.price === null && quote.otherSidePrice === null) continue;

    // Deliberately computed from both prices rather than the taken side's, so the OVER and the
    // UNDER row agree on which selection is a given book's main line.
    const lopsidedness =
      quote.price === null || quote.otherSidePrice === null
        ? Math.abs(impliedProbability((quote.price ?? quote.otherSidePrice) as number) - 0.5) + 1
        : Math.abs(impliedProbability(quote.price) - impliedProbability(quote.otherSidePrice));

    // Whether this quote looks like a real two-sided market at all. Kept alongside the chosen entry
    // so a book can be dropped when even its *best* selection is a stray order.
    const nearMarket = [quote.price, quote.otherSidePrice]
      .filter((p): p is number => p !== null)
      .some((p) => {
        const prob = impliedProbability(p);
        return prob >= NEAR_MARKET_MIN_PROB && prob <= 1 - NEAR_MARKET_MIN_PROB;
      });

    const list = candidatesByBook.get(quote.bookKey) ?? [];
    list.push({ ...quote, nearMarket, lopsidedness });
    candidatesByBook.set(quote.bookKey, list);

    if (quote.line !== null) {
      if (!bookCountByLine.has(quote.line)) bookCountByLine.set(quote.line, new Set());
      bookCountByLine.get(quote.line)!.add(quote.bookKey);
    }
  }

  let consensusLine: number | null = null;
  let consensusCount = -1;
  for (const [line, books] of bookCountByLine) {
    if (books.size > consensusCount) {
      consensusCount = books.size;
      consensusLine = line;
    }
  }

  const out = new Map<string, BookMainLine>();
  for (const [bookKey, candidates] of candidatesByBook) {
    const atConsensus =
      consensusLine !== null ? candidates.find((c) => c.line === consensusLine) : undefined;
    const chosen =
      atConsensus ?? candidates.reduce((best, c) => (c.lopsidedness < best.lopsidedness ? c : best));
    const asked = atLine === null ? undefined : candidates.find((c) => c.line === atLine);
    out.set(bookKey, {
      label: chosen.label,
      line: chosen.line,
      price: chosen.price,
      otherSidePrice: chosen.otherSidePrice,
      liquidity: chosen.liquidity,
      nearMarket: chosen.nearMarket,
      priceAtLine: asked?.price ?? null,
      selectionsSeen: [
        ...new Set(candidates.map((c) => c.line).filter((l): l is number => l !== null)),
      ].sort((a, b) => a - b),
    });
  }
  return out;
}
