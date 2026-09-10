import { prisma } from "./prisma";
import { CLV_STATUSES, OPEN_STATUSES, SETTLED_STATUSES, type MarketType, type Status } from "./constants";
import { getAppSettings, sortByBookOrder } from "./app-settings";

export interface BetFilters {
  group?: "open" | "settled" | "all";
  status?: Status;
  site?: string;
  sport?: string;
  fantasyBook?: string;
  statMarket?: string;
  side?: string;
  /** Whether the pick was taken in-play or before kickoff. */
  live?: "live" | "prematch";
  /** Player prop vs whole-game market (spread, total). */
  marketType?: MarketType;
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
    live: (["live", "prematch"] as const).find((v) => v === clean("live")),
    marketType: (["PLAYER_PROP", "GAME_TOTAL", "SPREAD", "MONEYLINE", "OTHER"] as const).find(
      (v) => v === clean("market")
    ),
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
  if (filters.live) where.isLive = filters.live === "live";
  if (filters.marketType) where.marketType = filters.marketType;

  if (filters.verdict) {
    // CLV verdicts only exist on picks whose closing line was captured, so this narrows the
    // status set rather than replacing whatever was already there.
    where.status = statuses
      ? { in: statuses.filter((s) => (CLV_STATUSES as string[]).includes(s)) }
      : { in: CLV_STATUSES };
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
      // Game markets have no player, so their bet name is what a search has to hit.
      { selectionName: { contains: filters.q } },
      { subjectTeam: { contains: filters.q } },
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
  const [bet, settings] = await Promise.all([
    prisma.bet.findUnique({
      where: { id },
      include: {
        openLines: { orderBy: { bookKey: "asc" } },
        closeLines: { orderBy: { bookKey: "asc" } },
      },
    }),
    getAppSettings(),
  ]);
  if (!bet) return bet;
  // The alphabetical DB order is just a stable tiebreaker; the configured book order (Settings ->
  // Books) is what actually decides display order here.
  return {
    ...bet,
    openLines: sortByBookOrder(bet.openLines, settings.bookOrder),
    closeLines: sortByBookOrder(bet.closeLines, settings.bookOrder),
  };
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

  const closed = bets.filter((b) => (CLV_STATUSES as string[]).includes(b.status));
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
      /** Picks no sportsbook prices. Counted separately so they never read as a problem. */
      noClosingMarket: bets.filter((b) => b.status === "NO_CLOSING_MARKET").length,
      failed: bets.filter((b) => b.status === "FETCH_FAILED").length,
      /** In-play picks, which carry EV% but never a CLV verdict. */
      live: bets.filter((b) => b.status === "LIVE_NO_CLV").length,
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
  // The boards label tennis by tour; OddsJam files them all under one path.
  atp: "tennis",
  wta: "tennis",
  tennis: "tennis",
};

/**
 * Link to the site's own odds page for this pick, for looking a number up by hand.
 *
 * This used to build /<sport>/screen/<market> URLs, on the strength of them opening already
 * filtered. They need a subscription tier this account does not have, so every one of these links
 * was dead -- and the "opens already filtered to X" copy beside them promised something the user
 * could not even reach. /<sport>/odds is reachable; the market and player are then the site's own
 * dropdown and search.
 *
 * PropProfessor's screen keeps all of its filter state in memory: changing a dropdown never
 * changes the URL, and loading /screen?sport=NFL still shows MLB (both verified). So there is no
 * honest way to pre-fill that one either.
 *
 * This is a link a human clicks, which is ordinary browsing. It is unrelated to -- and must not be
 * confused with -- the closing read, which never contacts OddsJam automatically. See
 * extension/src/background/closing-worker.ts.
 */
export function oddsScreenUrlFor(bet: { site: string; sport: string | null }): {
  url: string;
  /** What the link genuinely lands on, so the copy beside it cannot overclaim again. */
  filteredTo: "sport" | "nothing";
} {
  if (bet.site !== "ODDSJAM") {
    return { url: "https://www.propprofessor.com/screen", filteredTo: "nothing" };
  }

  const sportSlug = ODDSJAM_SPORT_SLUG[(bet.sport ?? "").trim().toLowerCase()];
  if (!sportSlug) return { url: "https://oddsjam.com/betting-tools", filteredTo: "nothing" };

  return { url: `https://oddsjam.com/${sportSlug}/odds`, filteredTo: "sport" };
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

/** Enough of a pick to name it and to judge the rejection, without this module rendering anything. */
export interface ExclusionExample {
  id: string;
  player: string | null;
  selectionName: string | null;
  side: string | null;
  takenLine: number;
  statMarket: string;
  /** What this book had up at close. */
  line: number | null;
  /** What the rest of the field settled on, so the gap that triggered the rejection is visible. */
  consensus: number | null;
}

export interface ExclusionRow {
  bookKey: string;
  label: string;
  /** Picks where this book's closing quote was thrown out of the average. */
  excluded: number;
  /** Picks where it was present at close at all -- the denominator that makes `excluded` mean something. */
  seen: number;
  /** excluded / seen. The number worth sorting on; a book seen twice and dropped twice is noise. */
  rate: number;
  /** Most recent picks it was dropped on, for spot-checking whether the rejections were fair. */
  examples: ExclusionExample[];
}

export interface ExclusionAudit {
  /** Picks that carry a closing read at all, i.e. the population these rates are over. */
  picksWithClose: number;
  picksWithExclusions: number;
  books: ExclusionRow[];
}

/**
 * Which books keep getting thrown out of the closing average, and how often.
 *
 * The rejection itself is already visible per pick, in the note on its detail page. That is the
 * wrong altitude for the question this answers: a book being far from the field once is a stale
 * feed, and a book being far from the field on a quarter of the picks it appears on is a
 * mis-mapped `bookKey` -- the same name pointing at a different market, or an alt-line column
 * admitted as a main one. Only the rate across picks can tell those apart, and it is invisible
 * while the evidence is spread one sentence at a time across hundreds of detail pages.
 *
 * `seen` is deliberately the count of picks where the book was quoted at close, not the count of
 * all picks: a book that only ever appears on ten markets should not look reliable merely because
 * it was absent from the rest.
 */
export async function getExclusionAudit(limitPerBook = 5): Promise<ExclusionAudit> {
  const bets = await prisma.bet.findMany({
    where: { closeCapturedAt: { not: null } },
    orderBy: { closeCapturedAt: "desc" },
    select: {
      id: true,
      player: true,
      selectionName: true,
      side: true,
      takenLine: true,
      statMarket: true,
      avgClosingLine: true,
      excludedBooks: true,
      closeLines: { select: { bookKey: true, label: true, line: true } },
    },
    take: 3000,
  });

  const stats = new Map<string, { label: string; excluded: number; seen: number; examples: ExclusionRow["examples"] }>();
  let picksWithExclusions = 0;

  for (const bet of bets) {
    // Stored as JSON text because SQLite has no Json scalar; a row written before this column
    // existed, or corrupted by hand, must not take the whole page down.
    let excluded: string[] = [];
    try {
      const parsed = bet.excludedBooks ? (JSON.parse(bet.excludedBooks) as unknown) : [];
      if (Array.isArray(parsed)) excluded = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      excluded = [];
    }
    if (excluded.length > 0) picksWithExclusions += 1;
    const excludedSet = new Set(excluded);

    for (const line of bet.closeLines) {
      const entry = stats.get(line.bookKey) ?? {
        label: line.label ?? line.bookKey,
        excluded: 0,
        seen: 0,
        examples: [],
      };
      entry.seen += 1;
      if (excludedSet.has(line.bookKey)) {
        entry.excluded += 1;
        if (entry.examples.length < limitPerBook) {
          entry.examples.push({
            id: bet.id,
            player: bet.player,
            selectionName: bet.selectionName,
            side: bet.side,
            takenLine: bet.takenLine,
            statMarket: bet.statMarket,
            line: line.line,
            consensus: bet.avgClosingLine,
          });
        }
      }
      stats.set(line.bookKey, entry);
    }
  }

  return {
    picksWithClose: bets.length,
    picksWithExclusions,
    books: [...stats.entries()]
      .map(([bookKey, v]) => ({
        bookKey,
        label: v.label,
        excluded: v.excluded,
        seen: v.seen,
        rate: v.seen ? v.excluded / v.seen : 0,
        examples: v.examples,
      }))
      .filter((b) => b.excluded > 0)
      .sort((a, b) => b.rate - a.rate || b.excluded - a.excluded),
  };
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
      const settled = rows.filter(
        (r) => (CLV_STATUSES as string[]).includes(r.status) && r.edge !== null
      );
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
