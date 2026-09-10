import type { ParsedRow } from "@clv/shared";
import { isSportsbookForAverage } from "@clv/shared";
import { averageClosingLine, computeClv } from "./clv";
import type { MarketType, Side } from "./constants";

export interface ClosingLineRecord {
  bookKey: string;
  label: string | null;
  line: number | null;
  price: number | null;
  logoUrl: string | null;
  rawText: string;
  includedInAverage: boolean;
}

export interface ClosingVerdict {
  status: "CLOSED" | "UNAVAILABLE";
  closeLines: ClosingLineRecord[];
  avgClosingLine: number | null;
  closingBookCount: number;
  edge: number | null;
  beatClv: boolean | null;
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
  bookWeights?: Record<string, number> | null
): ClosingVerdict {
  const closeLines: ClosingLineRecord[] = row.bookLines.map((b) => ({
    bookKey: b.bookKey,
    label: b.label,
    line: b.line,
    price: b.price,
    logoUrl: b.logoUrl,
    rawText: b.rawText,
    includedInAverage: isSportsbookForAverage(b.bookKey, b.label, typeof b.line === "number"),
  }));

  const { avg, count } = averageClosingLine(closeLines, bookWeights);

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
      edge: null,
      beatClv: null,
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
    edge,
    beatClv,
    note: null,
    closingSource,
  };
}
