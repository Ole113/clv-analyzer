import { prisma } from "./prisma";
import { OPEN_STATUSES, SETTLED_STATUSES, type Status } from "./constants";

export interface BetFilters {
  group?: "open" | "settled" | "all";
  status?: Status;
  site?: string;
  sport?: string;
  fantasyBook?: string;
  statMarket?: string;
  side?: string;
  /** Free-text search across player, stat, matchup and teams. */
  q?: string;
  verdict?: "beat" | "missed";
  from?: Date;
  to?: Date;
  limit: number;
}

export function parseBetFilters(params: URLSearchParams): BetFilters {
  const group = params.get("group");
  const from = params.get("from");
  const to = params.get("to");
  const verdict = params.get("verdict");
  const clean = (key: string): string | undefined => {
    const value = params.get(key)?.trim();
    return value ? value : undefined;
  };
  return {
    group: group === "open" || group === "settled" ? group : "all",
    status: (clean("status") as Status) ?? undefined,
    site: clean("site"),
    sport: clean("sport"),
    fantasyBook: clean("book"),
    statMarket: clean("stat"),
    side: clean("side"),
    q: clean("q"),
    verdict: verdict === "beat" || verdict === "missed" ? verdict : undefined,
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
    limit: Math.min(Number(params.get("limit") ?? 200), 1000),
  };
}

function whereFrom(filters: BetFilters) {
  const statuses =
    filters.status !== undefined
      ? [filters.status]
      : filters.group === "open"
        ? OPEN_STATUSES
        : filters.group === "settled"
          ? SETTLED_STATUSES
          : undefined;

  // SQLite's LIKE is case-insensitive for ASCII, which is what Prisma's `contains` compiles to,
  // so free-text search needs no extra normalisation column.
  const q = filters.q;
  return {
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(filters.site ? { site: filters.site } : {}),
    ...(filters.sport ? { sport: filters.sport } : {}),
    ...(filters.fantasyBook ? { fantasyBook: filters.fantasyBook } : {}),
    ...(filters.statMarket ? { statMarket: filters.statMarket } : {}),
    ...(filters.side ? { side: filters.side } : {}),
    ...(filters.verdict ? { status: "CLOSED", beatClv: filters.verdict === "beat" } : {}),
    ...(q
      ? {
          OR: [
            { player: { contains: q } },
            { statMarket: { contains: q } },
            { matchup: { contains: q } },
            { team: { contains: q } },
            { opponent: { contains: q } },
            { sport: { contains: q } },
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
  };
}

export async function listBets(filters: BetFilters) {
  return prisma.bet.findMany({
    where: whereFrom(filters),
    orderBy: [{ gameStartTime: "desc" }, { openCapturedAt: "desc" }],
    take: filters.limit,
  });
}

export async function getBetDetail(id: string) {
  const bet = await prisma.bet.findUnique({
    where: { id },
    include: {
      openLines: { orderBy: { bookKey: "asc" } },
      closeLines: { orderBy: { bookKey: "asc" } },
    },
  });
  return bet;
}

export interface Breakdown {
  key: string;
  n: number;
  beat: number;
  beatRate: number | null;
  avgEdge: number | null;
}

function summarize(
  rows: { beatClv: boolean | null; edge: number | null; closeEvPercent?: number | null }[]
): { n: number; beat: number; beatRate: number | null; avgEdge: number | null; avgEv: number | null } {
  const scored = rows.filter((r) => r.beatClv !== null && r.edge !== null);
  const n = scored.length;
  const beat = scored.filter((r) => r.beatClv).length;
  const avgEdge = n ? scored.reduce((s, r) => s + (r.edge as number), 0) / n : null;
  const evs = rows.map((r) => r.closeEvPercent).filter((v): v is number => v !== null && v !== undefined);
  return {
    n,
    beat,
    beatRate: n ? beat / n : null,
    avgEdge,
    avgEv: evs.length ? evs.reduce((s, v) => s + v, 0) / evs.length : null,
  };
}

/**
 * Beat-rate and average edge are computed only over CLOSED picks -- picks that never got a
 * closing line must not silently count as losses. The unavailable/failed counts are returned
 * alongside so a broken session or matcher is visible instead of quietly shrinking the sample.
 */
export async function getOverviewStats(filters: BetFilters) {
  const where = whereFrom({ ...filters, group: "all", status: undefined });
  const bets = await prisma.bet.findMany({
    where,
    select: {
      status: true,
      beatClv: true,
      edge: true,
      closeEvPercent: true,
      sport: true,
      site: true,
      fantasyBook: true,
      statMarket: true,
    },
    take: 5000,
  });

  const closed = bets.filter((b) => b.status === "CLOSED");
  const overall = summarize(closed);

  const byKey = (pick: (b: (typeof bets)[number]) => string | null): Breakdown[] => {
    const groups = new Map<string, typeof closed>();
    for (const b of closed) {
      const key = pick(b) ?? "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(b);
    }
    return [...groups.entries()]
      .map(([key, rows]) => ({ key, ...summarize(rows) }))
      .sort((a, b) => b.n - a.n);
  };

  return {
    overall,
    counts: {
      total: bets.length,
      pending: bets.filter((b) => b.status === "PENDING").length,
      needsGameTime: bets.filter((b) => b.status === "NEEDS_GAME_TIME").length,
      due: bets.filter((b) => b.status === "DUE").length,
      closed: closed.length,
      unavailable: bets.filter((b) => b.status === "UNAVAILABLE").length,
      failed: bets.filter((b) => b.status === "FETCH_FAILED").length,
    },
    bySport: byKey((b) => b.sport),
    bySite: byKey((b) => b.site),
    byBook: byKey((b) => b.fantasyBook),
    byStat: byKey((b) => b.statMarket).slice(0, 12),
  };
}


export interface Facets {
  sports: string[];
  stats: string[];
  books: string[];
  sites: string[];
}

/** Distinct values actually present in the data, so the filter dropdowns never offer dead ends. */
export async function getFacets(): Promise<Facets> {
  const rows = await prisma.bet.findMany({
    select: { sport: true, statMarket: true, fantasyBook: true, site: true },
    take: 5000,
  });
  const uniq = (values: (string | null)[]): string[] =>
    [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));
  return {
    sports: uniq(rows.map((r) => r.sport)),
    stats: uniq(rows.map((r) => r.statMarket)),
    books: uniq(rows.map((r) => r.fantasyBook)),
    sites: uniq(rows.map((r) => r.site)),
  };
}

/** The public board this pick came from, for the "open on site" links. */
export function boardUrlFor(bet: {
  site: string;
  fantasyBook: string;
  pageUrl: string | null;
}): string {
  if (bet.pageUrl && /^https?:\/\//.test(bet.pageUrl)) return bet.pageUrl;
  return bet.site === "ODDSJAM"
    ? `https://fantasy.oddsjam.com/fantasy-odds/${bet.fantasyBook || "prizepicks"}`
    : "https://www.propprofessor.com/fantasy";
}

export interface SeriesPoint {
  /** ISO date (YYYY-MM-DD) of the bucket. */
  date: string;
  picks: number;
  settled: number;
  beatRate: number | null;
  avgEdge: number | null;
  avgEv: number | null;
  cumulativeEdge: number;
}

/**
 * Daily buckets for the overview chart, keyed on kickoff (falling back to capture time) so a
 * point reflects when the market actually closed rather than when the pick was noticed.
 */
export async function getTimeSeries(days = 45): Promise<SeriesPoint[]> {
  const since = new Date(Date.now() - days * 86400_000);
  const bets = await prisma.bet.findMany({
    where: { OR: [{ gameStartTime: { gte: since } }, { openCapturedAt: { gte: since } }] },
    select: {
      gameStartTime: true,
      openCapturedAt: true,
      status: true,
      beatClv: true,
      edge: true,
      closeEvPercent: true,
    },
    take: 5000,
  });

  const buckets = new Map<string, typeof bets>();
  for (const bet of bets) {
    const when = bet.gameStartTime ?? bet.openCapturedAt;
    const key = when.toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(bet);
  }

  let cumulative = 0;
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, rows]) => {
      const settled = rows.filter((r) => r.status === "CLOSED" && r.edge !== null);
      const evs = rows.map((r) => r.closeEvPercent).filter((v): v is number => v !== null);
      const edgeSum = settled.reduce((s, r) => s + (r.edge as number), 0);
      cumulative += edgeSum;
      return {
        date,
        picks: rows.length,
        settled: settled.length,
        beatRate: settled.length ? settled.filter((r) => r.beatClv).length / settled.length : null,
        avgEdge: settled.length ? edgeSum / settled.length : null,
        avgEv: evs.length ? evs.reduce((s, v) => s + v, 0) / evs.length : null,
        cumulativeEdge: Math.round(cumulative * 100) / 100,
      };
    });
}
