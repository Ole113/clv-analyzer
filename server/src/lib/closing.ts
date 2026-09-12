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
 * redesign -- but in exchange shows far more columns, most of which are not sportsbooks.
 */
export type ClosingSourceSite = "OPTIMIZER" | "PP_SCREEN";

export interface ClosingLineRecord {
  bookKey: string;
  label: string | null;
  line: number | null;
  price: number | null;
  logoUrl: string | null;
  liquidity: number | null;
  fairProbability: number | null;
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
  } = {}
): ClosingVerdict {
  // The screen needs an allowlist: on the optimizer the `hasLine` test did most of the filtering,
  // because DFS and algo columns there are price-only. On an odds screen essentially every column
  // carries a line, so a denylist admits anything it has not been told about yet.
  const classify = sourceSite === "PP_SCREEN" ? isSportsbookForClose : isSportsbookForAverage;

  const closeLines: ClosingLineRecord[] = row.bookLines.map((b) => ({
    bookKey: b.bookKey,
    label: b.label,
    line: b.line,
    price: b.price,
    logoUrl: b.logoUrl,
    liquidity: b.liquidity ?? null,
    fairProbability: b.fairProbability ?? null,
    rawText: b.rawText,
    includedInAverage: classify(b.bookKey, b.label, typeof b.line === "number"),
  }));

  // Only on the screen path: it is the one that surfaces stale and mis-mapped books, and the
  // optimizer path must not silently change its numbers.
  const outliers =
    sourceSite === "PP_SCREEN" ? findLineOutliers(closeLines, marketType) : new Set<string>();
  for (const line of closeLines) {
    if (outliers.has(line.bookKey)) line.includedInAverage = false;
  }

  const { avg, count } = averageClosingLine(
    closeLines,
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
  } = averageClosingPrice(closeLines, bookWeights, 1, options.useLiquidityWeighting === true);

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

  const { edge, beatClv } = computeClv(marketType, side, takenLine, closingLine);
  return {
    status: "CLOSED",
    closeLines,
    avgClosingLine: closingLine,
    // The board line is a single number, not a consensus of several books.
    closingBookCount: useBoardLine ? 1 : count,
    avgClosingPrice,
    avgClosingProbability,
    closingPriceBookCount,
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
