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
  /** Actual outcome of the pick. */
  result?: "WIN" | "LOSS" | "PUSH" | "VOID";
  /** Where a pick sits in the grading lifecycle. */
  graded?: "graded" | "ungraded" | "ungradeable" | "failed";
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
    result: (["WIN", "LOSS", "PUSH", "VOID"] as const).find((r) => r === clean("result")),
    graded: (["graded", "ungraded", "ungradeable", "failed"] as const).find(
      (g) => g === clean("graded")
    ),
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

  // Built by explicit assignment rather than spreading several objects that each carry a `status`
  // key: a spread let the CLV-verdict filter silently overwrite an active status filter.
  const where: Record<string, unknown> = {};
  if (statuses) where.status = { in: statuses };
  if (filters.site) where.site = filters.site;
  if (filters.sport) where.sport = filters.sport;
  if (filters.fantasyBook) where.fantasyBook = filters.fantasyBook;
  if (filters.statMarket) where.statMarket = filters.statMarket;
  if (filters.side) where.side = filters.side;

  if (filters.verdict) {
    // CLV verdicts only exist on picks whose closing line was captured, so this narrows the
    // status set rather than replacing whatever was already there.
    where.status = statuses ? { in: statuses.filter((s) => s === "CLOSED") } : "CLOSED";
    where.beatClv = filters.verdict === "beat";
  }

  if (filters.result) where.gradeResult = filters.result;
  if (filters.graded === "graded") where.gradeResult = { in: ["WIN", "LOSS", "PUSH", "VOID"] };
  if (filters.graded === "ungraded") where.gradeResult = null;
  if (filters.graded === "ungradeable") where.gradeResult = "UNGRADEABLE";
  if (filters.graded === "failed") where.gradeResult = "GRADE_FAILED";

  if (filters.q) {
    // SQLite's LIKE is case-insensitive for ASCII, which is what Prisma's `contains` compiles to.
    where.OR = [
      { player: { contains: filters.q } },
      { statMarket: { contains: filters.q } },
      { matchup: { contains: filters.q } },
      { team: { contains: filters.q } },
      { opponent: { contains: filters.q } },
      { sport: { contains: filters.q } },
    ];
  }

  if (filters.from || filters.to) {
    where.openCapturedAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }

  return where;
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
      gradeResult: true,
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

  const graded = bets.filter((b) => b.gradeResult === "WIN" || b.gradeResult === "LOSS");
  const wins = graded.filter((b) => b.gradeResult === "WIN").length;

  return {
    overall,
    grading: {
      wins,
      losses: graded.length - wins,
      pushes: bets.filter((b) => b.gradeResult === "PUSH").length,
      voids: bets.filter((b) => b.gradeResult === "VOID").length,
      decided: graded.length,
      hitRate: graded.length ? wins / graded.length : null,
      ungradeable: bets.filter((b) => b.gradeResult === "UNGRADEABLE").length,
      failed: bets.filter((b) => b.gradeResult === "GRADE_FAILED").length,
      awaiting: bets.filter((b) => b.gradeResult === null).length,
    },
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

/** Sport strings the boards emit -> OddsJam's URL path segment. */
const ODDSJAM_SPORT_SLUG: Record<string, string> = {
  nfl: "nfl",
  ncaaf: "ncaaf",
  "college football": "ncaaf",
  nba: "nba",
  wnba: "wnba",
  mlb: "mlb",
  nhl: "nhl",
  ncaab: "ncaab",
};

/**
 * Link to the site's own odds screen for this prop.
 *
 * OddsJam encodes sport and market in the path, so the screen opens already filtered:
 * /nfl/screen/player-passing-yards renders "Sportsbook Screen - NFL - Player-passing-yards"
 * (verified against the live site). The player is not part of any supported URL, so the last hop
 * is the site's own search.
 *
 * PropProfessor's screen keeps all of its filter state in memory: changing a dropdown never
 * changes the URL, and loading /screen?sport=NFL still shows MLB (both verified). So there is no
 * honest way to pre-fill it, and the link goes to the plain screen.
 */
export function oddsScreenUrlFor(bet: {
  site: string;
  sport: string | null;
  statMarket: string;
}): { url: string; prefilled: boolean } {
  if (bet.site !== "ODDSJAM") {
    return { url: "https://www.propprofessor.com/screen", prefilled: false };
  }

  const sportSlug = ODDSJAM_SPORT_SLUG[(bet.sport ?? "").trim().toLowerCase()];
  if (!sportSlug) return { url: "https://oddsjam.com/betting-tools", prefilled: false };

  // "Fantasy Score (PrizePicks)" -> "fantasy-score": the book qualifier is not part of the market.
  const marketSlug = bet.statMarket
    .replace(/\([^)]*\)/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!marketSlug) return { url: `https://oddsjam.com/${sportSlug}/screen/moneyline`, prefilled: false };
  return { url: `https://oddsjam.com/${sportSlug}/screen/${marketSlug}`, prefilled: true };
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
  hitRate: number | null;
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
      gradeResult: true,
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
        hitRate: (() => {
          const w = rows.filter((r) => r.gradeResult === "WIN").length;
          const l = rows.filter((r) => r.gradeResult === "LOSS").length;
          return w + l ? w / (w + l) : null;
        })(),
        avgEdge: settled.length ? edgeSum / settled.length : null,
        avgEv: evs.length ? evs.reduce((s, v) => s + v, 0) / evs.length : null,
        cumulativeEdge: Math.round(cumulative * 100) / 100,
      };
    });
}
