import type { ParsedRow } from "@clv/shared";
import { isSportsbookForAverage } from "@clv/shared";
import { averageClosingLine, computeClv } from "./clv";
import type { Side } from "./constants";

export interface ClosingLineRecord {
  bookKey: string;
  label: string | null;
  line: number | null;
  price: number | null;
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
}

/**
 * Turns a freshly parsed closing row into the verdict to persist. Pure so the CLV rules can be
 * tested against real board data without launching a browser.
 */
export function buildClosingVerdict(side: Side, takenLine: number, row: ParsedRow): ClosingVerdict {
  const closeLines: ClosingLineRecord[] = row.bookLines.map((b) => ({
    bookKey: b.bookKey,
    label: b.label,
    line: b.line,
    price: b.price,
    rawText: b.rawText,
    includedInAverage: isSportsbookForAverage(b.bookKey, b.label, typeof b.line === "number"),
  }));

  const { avg, count } = averageClosingLine(closeLines);

  if (avg === null) {
    return {
      status: "UNAVAILABLE",
      closeLines,
      avgClosingLine: null,
      closingBookCount: 0,
      edge: null,
      beatClv: null,
      note: "No sportsbook was still quoting a line for this prop",
    };
  }

  const { edge, beatClv } = computeClv(side, takenLine, avg);
  return {
    status: "CLOSED",
    closeLines,
    avgClosingLine: avg,
    closingBookCount: count,
    edge,
    beatClv,
    note: null,
  };
}
