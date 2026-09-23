import type { ParsedRow } from "@clv/shared";
import { isSportsbookForAverage, isSportsbookForClose } from "@clv/shared";
import {
  averageClosingLine,
  averageClosingPrice,
  averageClosingProbability,
  computeClv,
  findLineOutliers,
} from "./clv";
import type { MarketType, Side } from "./constants";

/**
 * Where the closing numbers came from, which decides how they are filtered.
 *
 * OPTIMIZER is the legacy read off the edge-filtered Fantasy Optimizer. PP_SCREEN is the odds
 * screen, which lists every market whether or not any edge is left -- the whole point of the
 * redesign -- but in exchange shows far more columns, most of which are not sportsbooks. ODDS_API
 * is the modal's second source and is filtered exactly like PP_SCREEN, for the same reason: it too
 * carries a line on essentially every column, DFS apps included, so a denylist would admit them.
 *
 * ODDS_TERMINAL is the modal's default source and is filtered identically again, for the identical
 * reason: it too quotes a line on essentially every column it returns, DFS apps included.
 *
 * ODDS_API and ODDS_TERMINAL are deliberately grouped with PP_SCREEN rather than given their own
 * filtering rules. The tabs are only worth comparing if the books that count and the outliers that
 * are dropped are decided the same way in all of them -- otherwise a difference between the tabs
 * reads as a difference between sportsbooks when it is really a difference between our own
 * settings. Note this needs no new branch below: the `sourceSite === "OPTIMIZER"` test is an
 * else-catchall, so every feed source lands on `isSportsbookForClose` by construction.
 */
export type ClosingSourceSite = "OPTIMIZER" | "PP_SCREEN" | "ODDS_API" | "ODDS_TERMINAL";

export interface ClosingLineRecord {
  bookKey: string;
  label: string | null;
  line: number | null;
  price: number | null;
  logoUrl: string | null;
  liquidity: number | null;
  fairProbability: number | null;
  /**
   * What this book pays for the taken side at the line actually taken, where it quotes that line.
   *
   * Null on every path but an on-demand odds read, and null there for a book that is not quoting
   * that number at all. `line`/`price` above remain the book's own main line, which is what the
   * closing average is formed from -- this is shown beside it, never instead of it.
   */
  priceAtLine: number | null;
  rawText: string;
  includedInAverage: boolean;
}

export interface ClosingVerdict {
  status: "CLOSED" | "UNAVAILABLE";
  closeLines: ClosingLineRecord[];
  avgClosingLine: number | null;
  closingBookCount: number;
  /**
   * What the field is charging for the taken side right now, in American odds.
   *
   * Separate from `avgClosingLine` because on many markets the line cannot move and the price is
   * the only thing that does -- a passing-touchdowns prop sits on 2.5 all week while its price
   * travels from -110 to -145, which `avgClosingLine` and `edge` both report as "nothing happened".
   * Averaged in probability space; see `averageClosingPrice` for why American odds cannot be added
   * up directly. Vigged on purpose: this is the price on the screen, not a fair-value estimate --
   * `closeFairProb` is the de-vigged one.
   */
  avgClosingPrice: number | null;
  /** The same number as a 0-1 implied probability, vig included. */
  avgClosingProbability: number | null;
  /** How many books quoted the taken side at all. Always <= closingBookCount and often under it:
   *  a book is kept in the line average whenever it quotes the market, even on one side only. */
  closingPriceBookCount: number;
  /**
   * The line the books were *additionally* asked to price: the pick's own number.
   *
   * Non-null only when there is something extra to say -- an on-demand read where at least one book
   * quotes that line and at least one trusted book's own main line is a different number. On a
   * market where the field is already sitting on the taken line the two prices are the same number
   * twice, so this stays null and the caller shows one column, not two.
   */
  atLine: number | null;
  /** The field's price at `atLine`, averaged over exactly the books `avgClosingPrice` uses. Null
   *  whenever `atLine` is. */
  avgPriceAtLine: number | null;
  /** How many books were still quoting that line. */
  priceAtLineBookCount: number;
  edge: number | null;
  beatClv: boolean | null;
  /**
   * Movement measured in de-vigged win probability instead of line units, in probability points.
   *
   * Separate from `edge` rather than a correction to it, because they answer different questions.
   * A player prop moves by moving its number, and `edge` is the honest measure of that. A total
   * parked at 47.5 all week while the price drifts from -110 to -130 has moved hard against one
   * side, and `edge` reads exactly 0 -- this is the metric that sees it. Null unless both ends
   * carry a fair probability, since a one-ended difference is not a difference.
   */
  priceEdge: number | null;
  /**
   * The market's de-vigged probability that this pick hits, at close. Null when no trusted book
   * quoted both sides, which is common enough that callers must keep their capture-time fallback.
   */
  closeFairProb: number | null;
  /** How many books that consensus is over. Always <= closingBookCount; often well under it. */
  fairBookCount: number;
  /** Books dropped from the average, structurally rather than only as prose inside `note`. */
  excludedBooks: string[];
  note: string | null;
  /** How the closing number was obtained, so the two methods are never conflated on screen. */
  closingSource: "BOOK_CONSENSUS" | "BOARD_LINE";
}

/**
 * Turns a freshly parsed closing row into the verdict to persist. Pure so the CLV rules can be
 * tested against real board data without launching a browser -- weighting is passed in rather
 * than read from the database here, for the same reason.
 */
export function buildClosingVerdict(
  marketType: MarketType,
  side: Side | null,
  takenLine: number,
  row: ParsedRow,
  bookWeights?: Record<string, number> | null,
  sourceSite: ClosingSourceSite = "OPTIMIZER",
  options: {
    /** The pick's fair probability at capture, needed for the price-based edge. */
    openFairProb?: number | null;
    /** Whether captured depth should weight the average. Off unless the user turned it on. */
    useLiquidityWeighting?: boolean;
    /**
     * Set only for the board lookup, where nothing has been picked yet -- just a specific number
     * (`takenLine`) the user is looking at. Restricts `avgClosingLine`/`avgClosingPrice` to books
     * whose own line matches that number exactly, instead of blending in every book's own main line
     * even when most of the field sits on some other number entirely (a total-bases market with
     * books anchored anywhere from 0.5 to 2.5 has no honest single "average line"). Also suppresses
     * `edge`/`beatClv`, which ask how far the market has moved since a pick was taken -- a question
     * with no premise when there is no pick.
     */
    lookup?: boolean;
  } = {}
): ClosingVerdict {
  // Both odds sources need an allowlist: on the optimizer the `hasLine` test did most of the
  // filtering, because DFS and algo columns there are price-only. On an odds feed essentially every
  // column carries a line, so a denylist admits anything it has not been told about yet.
  const classify = sourceSite === "OPTIMIZER" ? isSportsbookForAverage : isSportsbookForClose;

  const closeLines: ClosingLineRecord[] = row.bookLines.map((b) => ({
    bookKey: b.bookKey,
    label: b.label,
    line: b.line,
    price: b.price,
    logoUrl: b.logoUrl,
    liquidity: b.liquidity ?? null,
    fairProbability: b.fairProbability ?? null,
    priceAtLine: b.priceAtLine ?? null,
    rawText: b.rawText,
    includedInAverage: classify(b.bookKey, b.label, typeof b.line === "number"),
  }));

  // On both odds-source paths, never on the optimizer: they are the ones that surface stale and
  // mis-mapped books, and the optimizer path must not silently change its numbers.
  const outliers =
    sourceSite === "OPTIMIZER" ? new Set<string>() : findLineOutliers(closeLines, marketType);
  for (const line of closeLines) {
    if (outliers.has(line.bookKey)) line.includedInAverage = false;
  }

  // On a lookup, a book only belongs in "the average" when it is quoting the exact number the user
  // is looking at -- its own main line being some other number is not a vote on this one. A separate
  // view rather than mutating `closeLines` itself, so the book table (built from `closeLines` below)
  // keeps showing the ordinary denylist/outlier reasons instead of "not averaged" on every book that
  // simply prices a different line, which is not a real exclusion.
  const averagingLines = options.lookup
    ? closeLines.map((l) =>
        l.includedInAverage && l.line === takenLine ? l : { ...l, includedInAverage: false }
      )
    : closeLines;

  const { avg, count } = averageClosingLine(
    averagingLines,
    bookWeights,
    1,
    options.useLiquidityWeighting === true
  );

  // Over exactly the same field as the line average, so the two can never describe different sets
  // of books. Computed unconditionally rather than only on the CLOSED path: a market whose line
  // could not be formed at all can still have a perfectly readable price, and that is precisely the
  // case where a price is the only thing left to say.
  const {
    avg: avgClosingPrice,
    avgProbability: avgClosingProbability,
    count: closingPriceBookCount,
  } = averageClosingPrice(averagingLines, bookWeights, 1, options.useLiquidityWeighting === true);

  // --- what the field pays at the line actually taken -------------------------------------------
  //
  // `avgClosingPrice` above is each book's price at *its own* main line, which is the right number
  // for CLV: it is the price attached to the line the consensus is formed from. It is not the
  // number in front of someone looking at an Over 15.5 on a DFS board while the sportsbooks sit on
  // 14.5 -- the price they can actually compare their payout against is the one quoted at 15.5, and
  // reading it off the 14.5 column overstates or understates it by however far the line moved.
  //
  // Same books, same weights: a quote dropped from the line average (a pick'em column, a stale
  // outlier) is no more trustworthy at an alt line than at its own.
  const atLineLines = closeLines
    .filter((l): l is ClosingLineRecord & { priceAtLine: number } => typeof l.priceAtLine === "number")
    .map((l) => ({ ...l, price: l.priceAtLine }));
  const { avg: avgPriceAtLine, count: priceAtLineBookCount } = averageClosingPrice(
    atLineLines,
    bookWeights,
    1,
    options.useLiquidityWeighting === true
  );
  // Worth showing only when it differs from what the Line column already says.
  const atLine =
    priceAtLineBookCount > 0 &&
    closeLines.some((l) => l.includedInAverage && l.line !== null && l.line !== takenLine)
      ? takenLine
      : null;

  // --- the market's fair price at close --------------------------------------------------------
  //
  // Over exactly the books that are already trusted for the line average: the allowlist has removed
  // the pick'em columns (a fixed -119/-119 payout de-vigs to a flat 50% that is a property of the
  // payout, not of the market) and the outlier test has removed the stale quotes. Books that priced
  // only one side simply have no fair probability to contribute, so this is a strictly smaller
  // sample than the line average -- 10 of 18 books on the captured Xavier Robinson market -- and it
  // is legitimately null on a row that still has a perfectly good closing line.
  const { avg: closeFairProb, count: fairBookCount } = averageClosingProbability(
    closeLines.filter((l) => l.includedInAverage),
    bookWeights
  );

  // Price-based CLV. Deliberately independent of everything below it: a pick whose closing LINE
  // could not be formed can still have a closing fair probability, and vice versa, so this is
  // computed from the two probabilities alone and survives the UNAVAILABLE return.
  const priceEdge =
    typeof options.openFairProb === "number" && closeFairProb !== null
      ? Math.round((closeFairProb - options.openFairProb) * 1e5) / 1e3
      : null;
  const excludedBooks = [...outliers];

  // Player props: the books each quote their own line, so the close is their consensus.
  //
  // Game markets (OddsJam rebet/fliff): the books quote only a PRICE -- verified across every
  // non-empty book cell on a live board, 786 of 786 carried a price and none carried a line.
  // There, the line is the row itself ("Over 14.5" on a 1st-quarter total), so the closing number
  // is the line the same market shows at close, read straight off the matched row.
  const useBoardLine = avg === null && marketType !== "PLAYER_PROP" && row.takenLine !== null;
  const closingLine = useBoardLine ? (row.takenLine as number) : avg;
  const closingSource: ClosingVerdict["closingSource"] = useBoardLine
    ? "BOARD_LINE"
    : "BOOK_CONSENSUS";

  if (closingLine === null) {
    return {
      status: "UNAVAILABLE",
      closeLines,
      avgClosingLine: null,
      closingBookCount: 0,
      avgClosingPrice,
      avgClosingProbability,
      closingPriceBookCount,
      atLine,
      avgPriceAtLine: atLine === null ? null : avgPriceAtLine,
      priceAtLineBookCount: atLine === null ? 0 : priceAtLineBookCount,
      edge: null,
      beatClv: null,
      priceEdge,
      closeFairProb,
      fairBookCount,
      excludedBooks,
      note:
        marketType === "PLAYER_PROP"
          ? "No sportsbook was still quoting a line for this prop"
          : "The board was no longer offering this market, so it has no closing line",
      closingSource,
    };
  }

  // No pick, no CLV: computing an edge from "the line the user happens to be looking at right now"
  // vs. "the field's average" would read as if a bet had already been placed and beaten or lost to
  // the close, which is not a question a lookup can answer.
  const { edge, beatClv } = options.lookup
    ? { edge: null, beatClv: null }
    : computeClv(marketType, side, takenLine, closingLine);
  return {
    status: "CLOSED",
    closeLines,
    avgClosingLine: closingLine,
    // The board line is a single number, not a consensus of several books.
    closingBookCount: useBoardLine ? 1 : count,
    avgClosingPrice,
    avgClosingProbability,
    closingPriceBookCount,
    atLine,
    avgPriceAtLine: atLine === null ? null : avgPriceAtLine,
    priceAtLineBookCount: atLine === null ? 0 : priceAtLineBookCount,
    edge,
    beatClv,
    priceEdge,
    closeFairProb,
    fairBookCount,
    excludedBooks,
    // Surfaced rather than silent: a dropped book is a judgement call, and the one place it would
    // do real damage is if it were wrong and nobody could see it had happened.
    note:
      outliers.size > 0
        ? `Excluded ${[...outliers].join(", ")} from the average: too far from the rest of the field`
        : null,
    closingSource,
  };
}
