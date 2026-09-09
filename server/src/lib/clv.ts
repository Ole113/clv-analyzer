import type { Side } from "./constants";

export interface LineLike {
  line: number | null;
  includedInAverage: boolean;
}

/**
 * Average of the closing lines across the real sportsbooks that were still quoting the prop.
 * Returns null when no book qualified -- callers must treat that as UNAVAILABLE rather than 0.
 */
export function averageClosingLine(lines: LineLike[]): { avg: number | null; count: number } {
  const usable = lines.filter((l) => l.includedInAverage && typeof l.line === "number");
  if (usable.length === 0) return { avg: null, count: 0 };
  const sum = usable.reduce((acc, l) => acc + (l.line as number), 0);
  return { avg: sum / usable.length, count: usable.length };
}

/**
 * Line-number-only CLV, per the agreed method.
 *
 * An Over beats the close when the market moved the number UP: the bettor needed fewer than the
 * market later demanded. An Under beats the close when the number moved DOWN. Price movement is
 * captured for reference but deliberately does not feed the verdict.
 *
 * A perfectly flat line is not a win: no edge was gained, so beatClv is false at edge === 0.
 */
export function computeClv(
  side: Side,
  takenLine: number,
  avgClosingLine: number
): { edge: number; beatClv: boolean } {
  const edge = side === "OVER" ? avgClosingLine - takenLine : takenLine - avgClosingLine;
  const rounded = Math.round(edge * 1e6) / 1e6;
  return { edge: rounded, beatClv: rounded > 0 };
}
