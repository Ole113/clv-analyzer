import { normalizeName } from "@clv/shared";

export { normalizeName, stripTrailingLine, findMatchingRow, type MatchTarget } from "@clv/shared";

/**
 * Deterministic identity for a captured pick. Deliberately excludes the line: the same pick keeps
 * its key as the market moves, which is what lets the closing capture find it again.
 */
export function buildMatchKey(input: {
  site: string;
  fantasyBook: string;
  sport: string | null;
  player: string;
  statMarket: string;
  side: string;
  gameStartTime: Date | null;
}): string {
  return [
    input.site,
    input.fantasyBook.toLowerCase(),
    normalizeName(input.sport),
    normalizeName(input.player),
    normalizeName(input.statMarket),
    input.side,
    input.gameStartTime ? input.gameStartTime.toISOString().slice(0, 16) : "no-time",
  ].join("|");
}
