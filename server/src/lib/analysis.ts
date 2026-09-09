import { prisma } from "./prisma";
import { bookFavorability } from "./ev";
import type { BetFilters } from "./queries";
import type { Side } from "./constants";

export interface PropRow {
  key: string;
  n: number;
  beat: number;
  beatRate: number | null;
  avgEdge: number | null;
  /** Mean closing EV% across picks that had one. */
  avgEv: number | null;
  /** Sum of EV% across losing picks -- "how much EV this prop type cost you". */
  evLost: number;
  /** Sum of EV% across winning picks. */
  evGained: number;
}

export interface BookRow {
  bookKey: string;
  label: string;
  n: number;
  /** Mean favourability vs the consensus close; negative means a worse number than the market. */
  avgFavorability: number;
}

export interface SideRow {
  side: Side;
  n: number;
  beatRate: number | null;
  avgEv: number | null;
  avgEdge: number | null;
}

export interface AnalysisResult {
  sampleSize: number;
  withEv: number;
  overall: { beatRate: number | null; avgEdge: number | null; avgEv: number | null };
  byStat: PropRow[];
  bySport: PropRow[];
  bySide: SideRow[];
  /** Books ranked by how unfavourable their closing number was, for the filtered picks. */
  worstBooks: BookRow[];
  /** Same ranking, split per prop type, for the "avoid this book on this prop" view. */
  worstBooksByStat: { stat: string; books: BookRow[] }[];
}

function summarize(rows: { beatClv: boolean | null; edge: number | null; closeEvPercent: number | null }[]) {
  const scored = rows.filter((r) => r.beatClv !== null && r.edge !== null);
  const evs = rows.map((r) => r.closeEvPercent).filter((v): v is number => v !== null);
  const n = scored.length;
  return {
    n,
    beat: scored.filter((r) => r.beatClv).length,
    beatRate: n ? scored.filter((r) => r.beatClv).length / n : null,
    avgEdge: n ? scored.reduce((s, r) => s + (r.edge as number), 0) / n : null,
    avgEv: evs.length ? evs.reduce((s, v) => s + v, 0) / evs.length : null,
    evLost: evs.filter((v) => v < 0).reduce((s, v) => s + v, 0),
    evGained: evs.filter((v) => v > 0).reduce((s, v) => s + v, 0),
  };
}

function group<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row) ?? "unknown";
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(row);
  }
  return out;
}

/**
 * Everything the analysis page ranks on, computed over settled picks only.
 *
 * Picks that never got a closing line are excluded rather than counted as losses -- and the
 * page reports how many of the filtered picks actually carry an EV number, so a thin sample is
 * visible instead of being averaged into a confident-looking figure.
 */
export async function getAnalysis(
  filters: BetFilters & { minSample?: number }
): Promise<AnalysisResult> {
  const bets = await prisma.bet.findMany({
    where: {
      status: "CLOSED",
      ...(filters.site ? { site: filters.site } : {}),
      ...(filters.sport ? { sport: filters.sport } : {}),
      ...(filters.fantasyBook ? { fantasyBook: filters.fantasyBook } : {}),
      ...(filters.statMarket ? { statMarket: filters.statMarket } : {}),
      ...(filters.side ? { side: filters.side } : {}),
      ...(filters.verdict ? { beatClv: filters.verdict === "beat" } : {}),
      ...(filters.q
        ? {
            OR: [
              { player: { contains: filters.q } },
              { statMarket: { contains: filters.q } },
              { matchup: { contains: filters.q } },
            ],
          }
        : {}),
      ...(filters.from || filters.to
        ? {
            openCapturedAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    include: { closeLines: true },
    take: 3000,
  });

  const minSample = filters.minSample ?? 1;

  const toPropRows = (map: Map<string, typeof bets>): PropRow[] =>
    [...map.entries()]
      .map(([key, rows]) => ({ key, ...summarize(rows) }))
      .filter((r) => r.n >= minSample)
      .sort((a, b) => (b.avgEv ?? -Infinity) - (a.avgEv ?? -Infinity));

  const bySide: SideRow[] = (["OVER", "UNDER"] as Side[]).map((side) => {
    const rows = bets.filter((b) => b.side === side);
    const s = summarize(rows);
    return { side, n: s.n, beatRate: s.beatRate, avgEv: s.avgEv, avgEdge: s.avgEdge };
  });

  // --- book favourability: how each book's closing number compared with the consensus ---
  const bookTotals = new Map<string, { label: string; sum: number; n: number }>();
  const bookByStat = new Map<string, Map<string, { label: string; sum: number; n: number }>>();

  for (const bet of bets) {
    if (bet.avgClosingLine === null) continue;
    for (const line of bet.closeLines) {
      if (!line.includedInAverage || line.line === null) continue;
      const fav = bookFavorability(bet.side as Side, line.line, bet.avgClosingLine);
      const label = line.label ?? line.bookKey;

      const total = bookTotals.get(line.bookKey) ?? { label, sum: 0, n: 0 };
      total.sum += fav;
      total.n += 1;
      bookTotals.set(line.bookKey, total);

      const stat = bet.statMarket;
      if (!bookByStat.has(stat)) bookByStat.set(stat, new Map());
      const perStat = bookByStat.get(stat)!;
      const entry = perStat.get(line.bookKey) ?? { label, sum: 0, n: 0 };
      entry.sum += fav;
      entry.n += 1;
      perStat.set(line.bookKey, entry);
    }
  }

  const toBookRows = (map: Map<string, { label: string; sum: number; n: number }>): BookRow[] =>
    [...map.entries()]
      .map(([bookKey, v]) => ({
        bookKey,
        label: v.label,
        n: v.n,
        avgFavorability: Math.round((v.sum / v.n) * 1000) / 1000,
      }))
      .sort((a, b) => a.avgFavorability - b.avgFavorability);

  const overall = summarize(bets);

  return {
    sampleSize: bets.length,
    withEv: bets.filter((b) => b.closeEvPercent !== null).length,
    overall: { beatRate: overall.beatRate, avgEdge: overall.avgEdge, avgEv: overall.avgEv },
    byStat: toPropRows(group(bets, (b) => b.statMarket)),
    bySport: toPropRows(group(bets, (b) => b.sport)),
    bySide,
    worstBooks: toBookRows(bookTotals),
    worstBooksByStat: [...bookByStat.entries()]
      .map(([stat, map]) => ({ stat, books: toBookRows(map) }))
      .sort((a, b) => b.books.length - a.books.length),
  };
}
