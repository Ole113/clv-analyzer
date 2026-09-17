import { prisma } from "../prisma";
import { MIN_RELIABLE_PICKS } from "../analysis";
import { marketLabel } from "./markets";
import { splitTagSet } from "./parse";

/**
 * Everything the Pikkit side of the analysis page ranks on.
 *
 * The captured-pick engine next door (`lib/analysis.ts`) measures *lines*: it knows the closing
 * consensus and nothing about money. This one is the mirror image -- it knows exactly what was
 * staked and returned and, for most books, nothing about the close. They deliberately do not share
 * an aggregator, because the two datasets do not share a single metric: there is no beat-CLV rate
 * here and no ROI there, and a shared `summarize` would end up as a function where half the fields
 * are null on any given call.
 *
 * Three conventions, applied everywhere, stated once:
 *
 * * **Turnover** is stake over *decided* bets -- wins and losses. Voids are no-action: the stake
 *   came back, so counting it as money risked would dilute every ROI by however many games got
 *   postponed. Pending bets are excluded entirely and reported as their own count.
 * * **ROI** is `profit / turnover`, from the export's own `profit` column, which is net.
 * * **Win rate** is `wins / (wins + losses)`, over the same decided set.
 *
 * On a DFS-heavy history a win rate is nearly meaningless on its own -- a 6.0-payout pick'em slip
 * hitting 30% of the time is excellent and one hitting 45% at 2.0 is a slow loss -- so ROI leads
 * everywhere and the win rate rides along beside it rather than in front.
 */

/** The user's own clock. Every "what time did I bet" answer is meaningless in any other zone. */
export const PIKKIT_TIMEZONE = "America/Denver";

export interface MoneyBlock {
  bets: number;
  /** Decided: wins + losses. The denominator of ROI and win rate alike. */
  decided: number;
  wins: number;
  losses: number;
  voids: number;
  pending: number;
  turnover: number;
  profit: number;
  roi: number | null;
  winRate: number | null;
  avgOdds: number | null;
  avgStake: number | null;
  /** Losses that cost nothing -- promo or free bets. See `PikkitBet.noRisk`. */
  noRisk: number;
}

export interface BreakdownRow extends MoneyBlock {
  key: string;
  label: string;
  /** False below the confidence floor: an ROI over three bets is not a finding. */
  reliable: boolean;
}

export interface SeriesPoint {
  date: string;
  bets: number;
  profit: number;
  cumulativeProfit: number;
  cumulativeRoi: number | null;
}

/**
 * Whether the price taken beat the price at close, for the books that report one.
 *
 * The nearest thing to CLV this dataset can offer, and it covers well under half the bets, so
 * `coverage` travels with it everywhere it is displayed.
 */
export interface ClosingBlock {
  /** Bets carrying a closing price AND a decided result. */
  n: number;
  /** Bets in the filtered set at all, so `n / total` is the coverage the page prints. */
  total: number;
  beatRate: number | null;
  /** Mean (implied probability at close - implied probability taken), in percentage points. */
  avgPriceEdgePts: number | null;
  beat: MoneyBlock;
  missed: MoneyBlock;
  /** ROI gained by having beaten the close, in percentage points. */
  lift: number | null;
}

/** Pikkit's own EV against what actually happened, in money rather than units. */
export interface ExpectationBlock {
  n: number;
  total: number;
  expectedProfit: number;
  actualProfit: number;
  deltaProfit: number;
  expectedRoi: number | null;
  actualRoi: number | null;
}

export interface StreakBlock {
  longestWin: number;
  longestLoss: number;
  /** Sign of the run in flight: positive for wins, negative for losses, 0 when there is none. */
  current: number;
}

/**
 * Whether the ROI above is a finding or a fortnight.
 *
 * A ratio estimator's standard error, which is the right one here: ROI is `sum(profit) /
 * sum(stake)`, a ratio of two random sums over *unequal* stakes, not the mean of a sample. Using
 * the plain standard error of per-bet returns would treat a 0.50 stake and a 50 stake as equally
 * informative and report a confidence interval far tighter than the record supports.
 */
export interface ConfidenceBlock {
  n: number;
  roi: number | null;
  /** 95% interval on ROI. Null when the sample is too thin for the approximation to mean anything. */
  low: number | null;
  high: number | null;
  /** ROI in standard errors from break-even. Above ~2 the record is unlikely to be noise. */
  z: number | null;
}

export interface PikkitAnalysisResult {
  headline: MoneyBlock;
  firstBet: Date | null;
  lastBet: Date | null;
  series: SeriesPoint[];
  byBook: BreakdownRow[];
  byBetType: BreakdownRow[];
  byLegCount: BreakdownRow[];
  byLeague: BreakdownRow[];
  bySport: BreakdownRow[];
  byMarket: BreakdownRow[];
  bySide: BreakdownRow[];
  byPlayer: BreakdownRow[];
  byWeekday: BreakdownRow[];
  byHour: BreakdownRow[];
  byOdds: BreakdownRow[];
  byStake: BreakdownRow[];
  byMonth: BreakdownRow[];
  byLive: BreakdownRow[];
  closing: ClosingBlock;
  expectation: ExpectationBlock;
  streaks: StreakBlock;
  confidence: ConfidenceBlock;
  /** Distinct legs that parsed to a market, and how many did not -- the exposure blocks' coverage. */
  legsParsed: number;
  legsTotal: number;
}

/**
 * The shape every aggregate below walks. Exported so the tests can build one without a database --
 * the aggregation is where the rules that are easy to get wrong live (which bets count toward
 * turnover, which group a mixed-league slip lands in, which side of a bucket edge a value falls),
 * and none of those need Prisma to be checked.
 */
export interface AnalysisRow {
  id: string;
  externalId: string;
  sportsbook: string;
  betType: string;
  result: string;
  oddsDecimal: number;
  closingDecimal: number | null;
  pikkitEv: number | null;
  stake: number;
  profit: number;
  placedAt: Date;
  betInfo: string;
  isLive: boolean;
  sportsRaw: string;
  leaguesRaw: string;
  legCount: number;
  noRisk: boolean;
  legs: { side: string | null; player: string | null; marketKey: string | null }[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function money(rows: AnalysisRow[]): MoneyBlock {
  const decided = rows.filter((r) => r.result === "WIN" || r.result === "LOSS");
  const wins = decided.filter((r) => r.result === "WIN").length;
  const turnover = decided.reduce((s, r) => s + r.stake, 0);
  const profit = decided.reduce((s, r) => s + r.profit, 0);
  return {
    bets: rows.length,
    decided: decided.length,
    wins,
    losses: decided.length - wins,
    voids: rows.filter((r) => r.result === "VOID").length,
    pending: rows.filter((r) => r.result === "PENDING").length,
    turnover: round2(turnover),
    profit: round2(profit),
    roi: turnover > 0 ? profit / turnover : null,
    winRate: decided.length ? wins / decided.length : null,
    avgOdds: rows.length ? rows.reduce((s, r) => s + r.oddsDecimal, 0) / rows.length : null,
    avgStake: rows.length ? round2(rows.reduce((s, r) => s + r.stake, 0) / rows.length) : null,
    noRisk: rows.filter((r) => r.noRisk).length,
  };
}

/**
 * Group into breakdown rows.
 *
 * `keys` returns a *list*, not one key, because several of these breakdowns are genuinely
 * many-to-many: a three-leg slip spanning MLB and NFL belongs under both leagues, and a slip with
 * a receptions leg and a rushing-yards leg belongs under both markets. Such a slip contributes its
 * whole stake and profit to each group it appears in, so the group ROIs answer "how have slips
 * touching this done" and do not sum back to the headline. Every caller that uses a multi-key
 * grouping says so in its lede.
 */
export function breakdown(
  rows: AnalysisRow[],
  keys: (row: AnalysisRow) => string[],
  label: (key: string) => string = (k) => k,
  order?: string[]
): BreakdownRow[] {
  const groups = new Map<string, AnalysisRow[]>();
  for (const row of rows) {
    // A slip listing the same league on two legs must still be counted once.
    for (const key of new Set(keys(row))) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
  }

  const out = [...groups.entries()].map(([key, group]) => ({
    key,
    label: label(key),
    ...money(group),
    reliable: group.filter((r) => r.result === "WIN" || r.result === "LOSS").length >= MIN_RELIABLE_PICKS,
  }));

  // A fixed order for buckets that have a natural one (hours, weekdays, odds bands); otherwise
  // most profitable first, with the sample size breaking ties.
  if (order) {
    const rank = new Map(order.map((k, i) => [k, i]));
    return out.sort((a, b) => (rank.get(a.key) ?? 999) - (rank.get(b.key) ?? 999));
  }
  return out.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity) || b.decided - a.decided);
}

// --- local time ---------------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Break a UTC instant into its parts in the user's zone.
 *
 * `Intl` rather than a date library, and rather than a fixed offset: Utah observes DST, so half a
 * multi-year export is UTC-7 and half is UTC-6. A hardcoded offset would file every summer evening
 * bet an hour late, which is exactly the kind of error a "best hour to bet" chart cannot survive.
 */
const FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: PIKKIT_TIMEZONE,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/** "0" (from `localParts().hour`, 24-hour) as a 12-hour clock label -- "12 AM", "1 PM", etc. */
export function hourLabel(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${period}`;
}

export function localParts(date: Date): {
  weekday: string;
  hour: number;
  dateKey: string;
  monthKey: string;
} {
  const parts = Object.fromEntries(
    FORMATTER.formatToParts(date).map((p) => [p.type, p.value])
  ) as Record<string, string>;
  return {
    weekday: parts.weekday,
    hour: Number(parts.hour),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    monthKey: `${parts.year}-${parts.month}`,
  };
}

// --- buckets ------------------------------------------------------------------------------------

/**
 * Decimal-odds bands.
 *
 * Chosen around how the bets are actually priced rather than evenly: almost everything in a DFS
 * history sits at 1.8-2.1 (a single pick'em leg) or at 3-7 (a two- to four-leg slip), so the
 * resolution belongs at those two clusters and nowhere in between.
 */
export const ODDS_BANDS: { key: string; from: number; to: number | null }[] = [
  { key: "< 1.9", from: 0, to: 1.9 },
  { key: "1.9-2.1", from: 1.9, to: 2.1 },
  { key: "2.1-3", from: 2.1, to: 3 },
  { key: "3-6", from: 3, to: 6 },
  { key: "6-10", from: 6, to: 10 },
  { key: "10+", from: 10, to: null },
];

export const STAKE_BANDS: { key: string; from: number; to: number | null }[] = [
  { key: "< $5", from: 0, to: 5 },
  { key: "$5-10", from: 5, to: 10 },
  { key: "$10-20", from: 10, to: 20 },
  { key: "$20-50", from: 20, to: 50 },
  { key: "$50+", from: 50, to: null },
];

/**
 * Half-open [from, to) throughout, so a bet landing exactly on a boundary lands in exactly one.
 *
 * Exported, with the band tables, for the same reason `edgeHistogram` next door is: a value
 * counted in two buckets or in none still produces a chart that looks entirely plausible.
 */
export function bandFor(bands: { key: string; from: number; to: number | null }[], value: number): string {
  const hit = bands.find((b) => value >= b.from && (b.to === null || value < b.to));
  return hit?.key ?? bands[bands.length - 1].key;
}

const LEG_BUCKETS = ["1 leg", "2 legs", "3 legs", "4 legs", "5+ legs"];
function legBucket(n: number): string {
  return n >= 5 ? "5+ legs" : LEG_BUCKETS[n - 1] ?? "1 leg";
}

// --- the blocks that are not plain breakdowns ---------------------------------------------------

/** Implied probability from decimal odds. Guarded: a 0 or negative price is not a price. */
function impliedFromDecimal(decimal: number): number | null {
  return decimal > 1 ? 1 / decimal : null;
}

function closingBlock(rows: AnalysisRow[]): ClosingBlock {
  const usable = rows.filter(
    (r) =>
      r.closingDecimal !== null &&
      r.closingDecimal > 1 &&
      r.oddsDecimal > 1 &&
      (r.result === "WIN" || r.result === "LOSS")
  );
  const beatRows = usable.filter((r) => r.oddsDecimal > (r.closingDecimal as number));
  const missedRows = usable.filter((r) => r.oddsDecimal <= (r.closingDecimal as number));

  const edges = usable
    .map((r) => {
      const taken = impliedFromDecimal(r.oddsDecimal);
      const close = impliedFromDecimal(r.closingDecimal as number);
      return taken !== null && close !== null ? (close - taken) * 100 : null;
    })
    .filter((v): v is number => v !== null);

  const beat = money(beatRows);
  const missed = money(missedRows);
  return {
    n: usable.length,
    total: rows.length,
    beatRate: usable.length ? beatRows.length / usable.length : null,
    avgPriceEdgePts: edges.length ? edges.reduce((s, v) => s + v, 0) / edges.length : null,
    beat,
    missed,
    lift: beat.roi !== null && missed.roi !== null ? (beat.roi - missed.roi) * 100 : null,
  };
}

function expectationBlock(rows: AnalysisRow[]): ExpectationBlock {
  const usable = rows.filter(
    (r) => r.pikkitEv !== null && (r.result === "WIN" || r.result === "LOSS")
  );
  const turnover = usable.reduce((s, r) => s + r.stake, 0);
  const expected = usable.reduce((s, r) => s + r.stake * (r.pikkitEv as number), 0);
  const actual = usable.reduce((s, r) => s + r.profit, 0);
  return {
    n: usable.length,
    total: rows.length,
    expectedProfit: round2(expected),
    actualProfit: round2(actual),
    deltaProfit: round2(actual - expected),
    expectedRoi: turnover > 0 ? expected / turnover : null,
    actualRoi: turnover > 0 ? actual / turnover : null,
  };
}

export function streaks(rows: AnalysisRow[]): StreakBlock {
  // Voids and pendings break nothing: a postponed game is not a loss, so a run of wins either side
  // of it is one run. They are skipped rather than treated as a boundary.
  const decided = rows
    .filter((r) => r.result === "WIN" || r.result === "LOSS")
    .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());

  let longestWin = 0;
  let longestLoss = 0;
  let run = 0;

  for (const row of decided) {
    const win = row.result === "WIN";
    run = win ? (run > 0 ? run + 1 : 1) : run < 0 ? run - 1 : -1;
    if (run > longestWin) longestWin = run;
    if (-run > longestLoss) longestLoss = -run;
  }

  return { longestWin, longestLoss, current: run };
}

export function confidence(rows: AnalysisRow[]): ConfidenceBlock {
  const decided = rows.filter((r) => r.result === "WIN" || r.result === "LOSS");
  const turnover = decided.reduce((s, r) => s + r.stake, 0);
  const profit = decided.reduce((s, r) => s + r.profit, 0);
  if (decided.length < 2 || turnover <= 0) {
    return { n: decided.length, roi: turnover > 0 ? profit / turnover : null, low: null, high: null, z: null };
  }

  const roi = profit / turnover;
  // Residual of each bet against what the overall ROI says it "should" have returned; the spread
  // of those is what the estimate's uncertainty is made of.
  const ss = decided.reduce((s, r) => s + (r.profit - roi * r.stake) ** 2, 0);
  const stdError = Math.sqrt(ss) / turnover;
  if (!Number.isFinite(stdError) || stdError === 0) {
    return { n: decided.length, roi, low: null, high: null, z: null };
  }

  return {
    n: decided.length,
    roi,
    low: roi - 1.96 * stdError,
    high: roi + 1.96 * stdError,
    z: roi / stdError,
  };
}

function series(rows: AnalysisRow[]): SeriesPoint[] {
  const byDay = new Map<string, { profit: number; bets: number; turnover: number }>();
  for (const row of rows) {
    if (row.result !== "WIN" && row.result !== "LOSS") continue;
    const { dateKey } = localParts(row.placedAt);
    const day = byDay.get(dateKey) ?? { profit: 0, bets: 0, turnover: 0 };
    day.profit += row.profit;
    day.turnover += row.stake;
    day.bets += 1;
    byDay.set(dateKey, day);
  }

  let cumulativeProfit = 0;
  let cumulativeTurnover = 0;
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => {
      cumulativeProfit += day.profit;
      cumulativeTurnover += day.turnover;
      return {
        date,
        bets: day.bets,
        profit: round2(day.profit),
        cumulativeProfit: round2(cumulativeProfit),
        cumulativeRoi: cumulativeTurnover > 0 ? cumulativeProfit / cumulativeTurnover : null,
      };
    });
}

// --- filters ------------------------------------------------------------------------------------

export interface PikkitFilters {
  book?: string;
  league?: string;
  sport?: string;
  market?: string;
  betType?: string;
  result?: string;
  live?: string;
  q?: string;
  from?: Date;
  to?: Date;
}

export function parsePikkitFilters(params: URLSearchParams): PikkitFilters {
  const str = (key: string) => params.get(key)?.trim() || undefined;
  const date = (key: string) => {
    const raw = str(key);
    if (!raw) return undefined;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  return {
    book: str("book"),
    league: str("league"),
    sport: str("sport"),
    market: str("market"),
    betType: str("betType"),
    result: str("result"),
    live: str("live"),
    q: str("q"),
    from: date("from"),
    to: date("to"),
  };
}

export interface PikkitFacets {
  books: string[];
  leagues: string[];
  sports: string[];
  markets: { key: string; label: string }[];
}

export async function getPikkitFacets(): Promise<PikkitFacets> {
  const [bets, markets] = await Promise.all([
    prisma.pikkitBet.findMany({ select: { sportsbook: true, leaguesRaw: true, sportsRaw: true } }),
    prisma.pikkitLeg.findMany({
      where: { marketKey: { not: null } },
      select: { marketKey: true },
      distinct: ["marketKey"],
    }),
  ]);

  const uniq = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return {
    books: uniq(bets.map((b) => b.sportsbook)),
    leagues: uniq(bets.flatMap((b) => splitTagSet(b.leaguesRaw))),
    sports: uniq(bets.flatMap((b) => splitTagSet(b.sportsRaw))),
    markets: markets
      .map((m) => ({ key: m.marketKey as string, label: marketLabel(m.marketKey) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

// --- the engine ---------------------------------------------------------------------------------

export async function getPikkitAnalysis(filters: PikkitFilters): Promise<PikkitAnalysisResult> {
  // League, sport and market all live in " | "-joined text or on child rows, so they cannot be
  // expressed as a SQLite `where` without either a LIKE that matches "NFL" inside "NFLX" or a join
  // that duplicates the parent row. They are applied in memory below, over the same array every
  // aggregate already walks.
  const rows = (await prisma.pikkitBet.findMany({
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
    include: { legs: { select: { side: true, player: true, marketKey: true } } },
    orderBy: { placedAt: "asc" },
  })) as AnalysisRow[];

  const filtered = rows.filter((row) => {
    if (filters.league && !splitTagSet(row.leaguesRaw).includes(filters.league)) return false;
    if (filters.sport && !splitTagSet(row.sportsRaw).includes(filters.sport)) return false;
    if (filters.market && !row.legs.some((l) => l.marketKey === filters.market)) return false;
    return true;
  });

  const hourOrder = Array.from({ length: 24 }, (_, h) => String(h));
  const allLegs = filtered.flatMap((r) => r.legs);

  return {
    headline: money(filtered),
    firstBet: filtered[0]?.placedAt ?? null,
    lastBet: filtered[filtered.length - 1]?.placedAt ?? null,
    series: series(filtered),

    byBook: breakdown(filtered, (r) => [r.sportsbook]),
    byBetType: breakdown(
      filtered,
      (r) => [r.betType],
      (k) => (k === "PARLAY" ? "Parlay / slip" : "Straight"),
      ["STRAIGHT", "PARLAY"]
    ),
    byLegCount: breakdown(filtered, (r) => [legBucket(r.legCount)], undefined, LEG_BUCKETS),
    byLeague: breakdown(filtered, (r) => splitTagSet(r.leaguesRaw)),
    bySport: breakdown(filtered, (r) => splitTagSet(r.sportsRaw)),
    byMarket: breakdown(
      filtered,
      (r) => r.legs.map((l) => l.marketKey).filter((k): k is string => k !== null),
      marketLabel
    ),
    bySide: breakdown(
      filtered,
      (r) => r.legs.map((l) => l.side).filter((s): s is string => s !== null),
      (k) => (k === "OVER" ? "Over / Higher" : "Under / Lower"),
      ["OVER", "UNDER"]
    ),
    byPlayer: breakdown(
      filtered,
      (r) => r.legs.map((l) => l.player).filter((p): p is string => p !== null)
    ).filter((r) => r.decided >= MIN_RELIABLE_PICKS),
    byWeekday: breakdown(
      filtered,
      (r) => [localParts(r.placedAt).weekday],
      undefined,
      WEEKDAYS
    ),
    byHour: breakdown(
      filtered,
      (r) => [String(localParts(r.placedAt).hour)],
      (k) => hourLabel(Number(k)),
      hourOrder
    ),
    byOdds: breakdown(
      filtered,
      (r) => [bandFor(ODDS_BANDS, r.oddsDecimal)],
      undefined,
      ODDS_BANDS.map((b) => b.key)
    ),
    byStake: breakdown(
      filtered,
      (r) => [bandFor(STAKE_BANDS, r.stake)],
      undefined,
      STAKE_BANDS.map((b) => b.key)
    ),
    byMonth: breakdown(
      filtered,
      (r) => [localParts(r.placedAt).monthKey],
      undefined,
      [...new Set(filtered.map((r) => localParts(r.placedAt).monthKey))].sort()
    ),
    byLive: breakdown(
      filtered,
      (r) => [r.isLive ? "live" : "prematch"],
      (k) => (k === "live" ? "Live" : "Pre-match"),
      ["prematch", "live"]
    ),

    closing: closingBlock(filtered),
    expectation: expectationBlock(filtered),
    streaks: streaks(filtered),
    confidence: confidence(filtered),
    legsParsed: allLegs.filter((l) => l.marketKey !== null).length,
    legsTotal: allLegs.length,
  };
}
