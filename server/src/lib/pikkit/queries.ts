import { prisma } from "../prisma";
import { splitTagSet } from "./parse";
import type { PikkitFilters } from "./analysis";

/**
 * Listing imported bets, for the `/bets` table.
 *
 * Shares `PikkitFilters` and its in-memory league/sport/market predicates with the analysis engine
 * deliberately: a filter that means one thing on the charts and another on the list would be worse
 * than no filter at all, and these three cannot be expressed in a SQLite `where` (see the note in
 * analysis.ts) so they have to be applied the same way in both places.
 */
export interface PikkitBetRow {
  id: string;
  externalId: string;
  sportsbook: string;
  betType: string;
  result: string;
  oddsDecimal: number;
  closingDecimal: number | null;
  stake: number;
  profit: number;
  placedAt: Date;
  isLive: boolean;
  leaguesRaw: string;
  legCount: number;
  legs: { legIndex: number; rawText: string }[];
}

export async function listPikkitBets(
  filters: PikkitFilters,
  limit = 300
): Promise<PikkitBetRow[]> {
  const rows = await prisma.pikkitBet.findMany({
    where: {
      ...(filters.book ? { sportsbook: filters.book } : {}),
      ...(filters.betType ? { betType: filters.betType } : {}),
      ...(filters.result ? { result: filters.result } : {}),
      ...(filters.live ? { isLive: filters.live === "live" } : {}),
      ...(filters.q ? { betInfo: { contains: filters.q } } : {}),
      ...(filters.from || filters.to
        ? {
            placedAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    include: {
      legs: { select: { legIndex: true, rawText: true, marketKey: true }, orderBy: { legIndex: "asc" } },
      },
    orderBy: { placedAt: "desc" },
    // Filtered after the query, so the cap is applied afterwards too -- taking 300 first and then
    // filtering would silently return fewer than 300 matching bets while claiming to be a full page.
    take: limit * 4,
  });

  return rows
    .filter((row) => {
      if (filters.league && !splitTagSet(row.leaguesRaw).includes(filters.league)) return false;
      if (filters.sport && !splitTagSet(row.sportsRaw).includes(filters.sport)) return false;
      if (filters.market && !row.legs.some((l) => l.marketKey === filters.market)) return false;
      return true;
    })
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      externalId: row.externalId,
      sportsbook: row.sportsbook,
      betType: row.betType,
      result: row.result,
      oddsDecimal: row.oddsDecimal,
      closingDecimal: row.closingDecimal,
      stake: row.stake,
      profit: row.profit,
      placedAt: row.placedAt,
      isLive: row.isLive,
      leaguesRaw: row.leaguesRaw,
      legCount: row.legCount,
      legs: row.legs.map((l) => ({ legIndex: l.legIndex, rawText: l.rawText })),
    }));
}
