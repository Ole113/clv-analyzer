import type { MarketType, Side } from "./constants";

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
 */
export function computeClv(
  marketType: MarketType,
  side: Side | null,
  takenLine: number,
  avgClosingLine: number
): { edge: number; beatClv: boolean } {
  const raw =
    marketType === "SPREAD"
      ? takenLine - avgClosingLine
      : side === "UNDER"
        ? takenLine - avgClosingLine
        : avgClosingLine - takenLine;
  const rounded = Math.round(raw * 1e6) / 1e6;
  // A perfectly flat line is not a win: no edge was gained, so beatClv is false at edge === 0.
  return { edge: rounded, beatClv: rounded > 0 };
}
