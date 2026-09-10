import { prisma } from "./prisma";
import { bookFavorability, decimalFromAmerican, DEFAULT_PICKEM_PRICE } from "./ev";
import type { BetFilters } from "./queries";
import type { Side } from "./constants";

export interface PropRow {
  key: string;
  n: number;
  beat: number;
  beatRate: number | null;
  /** Graded outcomes: decided = wins + losses; pushes and voids are no-action. */
  wins: number;
  losses: number;
  decided: number;
  hitRate: number | null;
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

/**
 * Whether betting *into* a given book has tended to beat the close.
 *
 * A different question from `BookRow.avgFavorability` above, which measures how good a book's
 * closing number was against the consensus -- a property of the book's price at one moment. This
 * measures the outcome of the picks that book was quoting: same underlying rows, opposite
 * direction of inference. Both are kept because a book can hang a generous number and still be
 * quoting markets that move against you.
 */
export interface BookScorecardRow {
  bookKey: string;
  label: string;
  /** Picks where this book had a closing line that counted toward the average. */
  picks: number;
  beatRate: number | null;
  avgEdge: number | null;
  avgEv: number | null;
  /** False when `picks` is below the confidence floor -- a 100% rate over 2 picks is noise. */
  reliable: boolean;
}

export interface MarketScorecardRow {
  statMarket: string;
  picks: number;
  beatRate: number | null;
  avgEdge: number | null;
  avgEv: number | null;
  hitRate: number | null;
  reliable: boolean;
}

/**
 * Below this many picks a rate is not reported as a finding.
 *
 * Not a filter -- the rows are still shown, because "this book has only been seen three times" is
 * itself worth knowing and hiding it would make the list silently incomplete. It only controls
 * whether a row is presented as a signal or as a sample too thin to read.
 */
export const MIN_RELIABLE_PICKS = 5;

/**
 * How CLV varied with how early the pick was taken.
 *
 * Buckets of (kickoff - capture), so the question is "how far ahead of the market was I", which is
 * the actionable version. Taking a number days early means beating a market that has not formed
 * yet; taking it minutes before kickoff means beating one that has already absorbed the news.
 * Which of those actually paid is not something the tool could answer before this.
 */
export interface TimingBucket {
  key: string;
  /** Inclusive lower bound in hours before kickoff; the last bucket is open-ended. */
  fromHours: number;
  /** Exclusive upper bound, or null for the open-ended bucket. */
  toHours: number | null;
  picks: number;
  avgEdge: number | null;
  beatRate: number | null;
  hitRate: number | null;
  avgEv: number | null;
}

/** One column of the edge histogram. `to` is exclusive; the outer buckets are open-ended. */
export interface EdgeBucket {
  key: string;
  from: number | null;
  to: number | null;
  picks: number;
  /** Share of the scored sample, 0-1, so the shape reads independently of sample size. */
  share: number;
}

export interface SideRow {
  side: Side;
  n: number;
  beatRate: number | null;
  avgEv: number | null;
  avgEdge: number | null;
  hitRate: number | null;
  wins: number;
  losses: number;
}

export interface AnalysisResult {
  sampleSize: number;
  /** Picks with a decided result (win or loss). */
  gradedSample: number;
  withEv: number;
  overall: {
    beatRate: number | null;
    avgEdge: number | null;
    avgEv: number | null;
    hitRate: number | null;
    wins: number;
    losses: number;
  };
  clvVsResult: { overall: ClvResultBlock; bySport: ClvResultBlock[] };
  expectation: ExpectationBlock;
  byStat: PropRow[];
  bySport: PropRow[];
  bySide: SideRow[];
  /** Books ranked by how unfavourable their closing number was, for the filtered picks. */
  worstBooks: BookRow[];
  /** Same ranking, split per prop type, for the "avoid this book on this prop" view. */
  worstBooksByStat: { stat: string; books: BookRow[] }[];
  /** Beat-rate and edge for picks each book was quoting -- not the same as favourability above. */
  bookScorecard: BookScorecardRow[];
  marketScorecard: MarketScorecardRow[];
  /** CLV against how far ahead of kickoff the pick was taken. */
  timing: TimingBucket[];
  /** The distribution of `edge`, not just its mean. */
  edgeHistogram: EdgeBucket[];
}

interface SummarizableRow {
  beatClv: boolean | null;
  edge: number | null;
  closeEvPercent: number | null;
  gradeResult: string | null;
}

function summarize(rows: SummarizableRow[]) {
  // CLV and result eligibility are independent: a pick whose closing line was never captured can
  // still have a perfectly good win, and a settled pick may not be graded yet.
  const scored = rows.filter((r) => r.beatClv !== null && r.edge !== null);
  const evs = rows.map((r) => r.closeEvPercent).filter((v): v is number => v !== null);
  const wins = rows.filter((r) => r.gradeResult === "WIN").length;
  const losses = rows.filter((r) => r.gradeResult === "LOSS").length;
  const decided = wins + losses;
  const n = scored.length;
  return {
    n,
    beat: scored.filter((r) => r.beatClv).length,
    beatRate: n ? scored.filter((r) => r.beatClv).length / n : null,
    wins,
    losses,
    decided,
    hitRate: decided ? wins / decided : null,
    avgEdge: n ? scored.reduce((s, r) => s + (r.edge as number), 0) / n : null,
    avgEv: evs.length ? evs.reduce((s, v) => s + v, 0) / evs.length : null,
    evLost: evs.filter((v) => v < 0).reduce((s, v) => s + v, 0),
    evGained: evs.filter((v) => v > 0).reduce((s, v) => s + v, 0),
  };
}

/**
 * Expected versus actual return.
 *
 * Each pick's EV% says what it should return per unit staked on average. Summing those gives the
 * profit the picks "should" have produced; summing the graded results gives what they actually
 * produced. The gap is variance -- running hot or cold relative to the edge the numbers claim.
 *
 * Only picks that are BOTH graded win/loss AND carry an EV% can appear, otherwise the two sides
 * would be measured over different samples and the gap would be meaningless.
 */
export interface ExpectationBlock {
  n: number;
  /** Units of profit the EV predicted, at 1 unit per pick. */
  expectedUnits: number;
  /** Units actually won or lost. */
  actualUnits: number;
  /** actual - expected. Positive = running above expectation. */
  deltaUnits: number;
  expectedHitRate: number | null;
  actualHitRate: number | null;
}

/** Hit rate split by whether the pick beat the close -- the test of whether CLV predicts results. */
export interface ClvResultCell {
  n: number;
  wins: number;
  hitRate: number | null;
}
export interface ClvResultBlock {
  key: string;
  beat: ClvResultCell;
  missed: ClvResultCell;
  /** Percentage points of hit rate gained by beating the close. Positive = CLV predicted hitting. */
  lift: number | null;
}

function expectation(
  rows: {
    gradeResult: string | null;
    closeEvPercent: number | null;
    openEvPercent: number | null;
    closeFairProb: number | null;
    openFairProb: number | null;
    fantasyPrice: number | null;
  }[]
): ExpectationBlock {
  const usable = rows.filter(
    (r) =>
      (r.gradeResult === "WIN" || r.gradeResult === "LOSS") &&
      (r.closeEvPercent ?? r.openEvPercent) !== null
  );

  let expectedUnits = 0;
  let actualUnits = 0;
  let probSum = 0;
  let probCount = 0;
  let wins = 0;

  for (const r of usable) {
    const ev = (r.closeEvPercent ?? r.openEvPercent) as number;
    expectedUnits += ev / 100;

    const decimal = decimalFromAmerican(r.fantasyPrice ?? DEFAULT_PICKEM_PRICE) ?? 1;
    if (r.gradeResult === "WIN") {
      actualUnits += decimal - 1;
      wins += 1;
    } else {
      actualUnits -= 1;
    }

    const prob = r.closeFairProb ?? r.openFairProb;
    if (prob !== null) {
      probSum += prob;
      probCount += 1;
    }
  }

  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    n: usable.length,
    expectedUnits: round(expectedUnits),
    actualUnits: round(actualUnits),
    deltaUnits: round(actualUnits - expectedUnits),
    expectedHitRate: probCount ? probSum / probCount : null,
    actualHitRate: usable.length ? wins / usable.length : null,
  };
}

function crosstab(key: string, rows: SummarizableRow[]): ClvResultBlock {
  // Only picks that have BOTH a CLV verdict and a decided result can appear here.
  const usable = rows.filter(
    (r) => r.beatClv !== null && (r.gradeResult === "WIN" || r.gradeResult === "LOSS")
  );
  const cell = (subset: SummarizableRow[]): ClvResultCell => {
    const wins = subset.filter((r) => r.gradeResult === "WIN").length;
    return { n: subset.length, wins, hitRate: subset.length ? wins / subset.length : null };
  };
  const beat = cell(usable.filter((r) => r.beatClv === true));
  const missed = cell(usable.filter((r) => r.beatClv === false));
  const lift =
    beat.hitRate !== null && missed.hitRate !== null ? (beat.hitRate - missed.hitRate) * 100 : null;
  return { key, beat, missed, lift };
}

/**
 * Bucket edges in hours before kickoff.
 *
 * Uneven on purpose, and roughly logarithmic: the hour before kickoff is where lines move most, so
 * the resolution belongs there rather than being spent separating "three days early" from "four".
 */
const TIMING_EDGES: { key: string; fromHours: number; toHours: number | null }[] = [
  { key: "< 1h", fromHours: 0, toHours: 1 },
  { key: "1-3h", fromHours: 1, toHours: 3 },
  { key: "3-8h", fromHours: 3, toHours: 8 },
  { key: "8-24h", fromHours: 8, toHours: 24 },
  { key: "1-3d", fromHours: 24, toHours: 72 },
  { key: "3d+", fromHours: 72, toHours: null },
];

// Exported for the unit tests: both bucketers have half-open boundary rules that are easy to get
// subtly wrong (a pick landing exactly on an edge counted twice, or in neither bucket), and that is
// exactly the kind of error that shows up as a plausible-looking distribution rather than a crash.
export function timingBuckets(
  rows: (SummarizableRow & { openCapturedAt: Date; gameStartTime: Date | null })[]
): TimingBucket[] {
  // A pick with no kickoff time has no lead time to measure, and one captured *after* kickoff is
  // an in-play capture whose "lead" is negative -- neither belongs on a pre-kickoff timing curve.
  const withLead = rows
    .filter((r): r is typeof r & { gameStartTime: Date } => r.gameStartTime !== null)
    .map((r) => ({
      row: r,
      hours: (r.gameStartTime.getTime() - r.openCapturedAt.getTime()) / 3600_000,
    }))
    .filter((r) => r.hours >= 0);

  return TIMING_EDGES.map((edge) => {
    const inBucket = withLead
      .filter((r) => r.hours >= edge.fromHours && (edge.toHours === null || r.hours < edge.toHours))
      .map((r) => r.row);
    const s = summarize(inBucket);
    return {
      key: edge.key,
      fromHours: edge.fromHours,
      toHours: edge.toHours,
      picks: s.n,
      avgEdge: s.avgEdge,
      beatRate: s.beatRate,
      hitRate: s.hitRate,
      avgEv: s.avgEv,
    };
  });
}

/** Bucket boundaries in line units. Symmetric so the shape's skew is readable at a glance. */
const EDGE_EDGES = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3];

/**
 * The distribution of `edge`, not just its mean.
 *
 * A mean edge of +0.2 can be a steady small win on most picks or a pile of small losses rescued by
 * two big hits, and those are completely different processes -- the second is not repeatable. The
 * average alone cannot tell them apart; the shape can.
 */
export function edgeHistogram(rows: SummarizableRow[]): EdgeBucket[] {
  const edges = rows
    .filter((r) => r.beatClv !== null && r.edge !== null)
    .map((r) => r.edge as number);
  const total = edges.length;

  const bounds: { key: string; from: number | null; to: number | null }[] = [
    { key: `< ${EDGE_EDGES[0]}`, from: null, to: EDGE_EDGES[0] },
    ...EDGE_EDGES.slice(0, -1).map((from, i) => ({
      key: `${from} to ${EDGE_EDGES[i + 1]}`,
      from,
      to: EDGE_EDGES[i + 1],
    })),
    { key: `${EDGE_EDGES[EDGE_EDGES.length - 1]}+`, from: EDGE_EDGES[EDGE_EDGES.length - 1], to: null },
  ];

  return bounds.map((b) => {
    // Half-open [from, to) throughout, so a pick landing exactly on 0 counts as "flat to +0.5"
    // rather than being double-counted or dropped between buckets.
    const picks = edges.filter(
      (e) => (b.from === null || e >= b.from) && (b.to === null || e < b.to)
    ).length;
    return { ...b, picks, share: total ? picks / total : 0 };
  });
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
      // Deliberately NOT gated on status "CLOSED". Grading is orthogonal to closing capture: a
      // pick whose closing line was never found can still have a real win, and excluding it here
      // would quietly drop it from every hit-rate figure.
      ...(filters.site ? { site: filters.site } : {}),
      ...(filters.sport ? { sport: filters.sport } : {}),
      ...(filters.fantasyBook ? { fantasyBook: filters.fantasyBook } : {}),
      ...(filters.statMarket ? { statMarket: filters.statMarket } : {}),
      ...(filters.side ? { side: filters.side } : {}),
      ...(filters.live ? { isLive: filters.live === "live" } : {}),
      ...(filters.marketType ? { marketType: filters.marketType } : {}),
      ...(filters.verdict ? { beatClv: filters.verdict === "beat" } : {}),
      ...(filters.q
        ? {
            OR: [
              { player: { contains: filters.q } },
              { selectionName: { contains: filters.q } },
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
    return {
      side,
      n: s.n,
      beatRate: s.beatRate,
      avgEv: s.avgEv,
      avgEdge: s.avgEdge,
      hitRate: s.hitRate,
      wins: s.wins,
      losses: s.losses,
    };
  });

  // --- book favourability: how each book's closing number compared with the consensus ---
  const bookTotals = new Map<string, { label: string; sum: number; n: number }>();
  const bookByStat = new Map<string, Map<string, { label: string; sum: number; n: number }>>();
  // Scorecard accumulators ride along on the same loop rather than re-querying: they are keyed on
  // the same (bet, closeLine) pairs, just aggregating the bet's verdict instead of the line's
  // distance from consensus. One book may quote a pick on several rows, so a bet is counted once
  // per book, not once per line.
  const scorecard = new Map<
    string,
    { label: string; picks: number; beat: number; scored: number; edgeSum: number; evSum: number; evN: number }
  >();

  for (const bet of bets) {
    if (bet.avgClosingLine === null) continue;
    const countedForBet = new Set<string>();
    for (const line of bet.closeLines) {
      if (!line.includedInAverage || line.line === null) continue;

      if (!countedForBet.has(line.bookKey)) {
        countedForBet.add(line.bookKey);
        const card = scorecard.get(line.bookKey) ?? {
          label: line.label ?? line.bookKey,
          picks: 0,
          beat: 0,
          scored: 0,
          edgeSum: 0,
          evSum: 0,
          evN: 0,
        };
        card.picks += 1;
        // Beat-rate and edge are over picks that actually carry a verdict, which is a subset of
        // the picks the book was quoting -- kept separate so a book is not penalised for picks
        // whose close was never resolved.
        if (bet.beatClv !== null && bet.edge !== null) {
          card.scored += 1;
          if (bet.beatClv) card.beat += 1;
          card.edgeSum += bet.edge;
        }
        if (bet.closeEvPercent !== null) {
          card.evSum += bet.closeEvPercent;
          card.evN += 1;
        }
        scorecard.set(line.bookKey, card);
      }

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

  const bookScorecard: BookScorecardRow[] = [...scorecard.entries()]
    .map(([bookKey, v]) => ({
      bookKey,
      label: v.label,
      picks: v.picks,
      beatRate: v.scored ? v.beat / v.scored : null,
      avgEdge: v.scored ? Math.round((v.edgeSum / v.scored) * 1000) / 1000 : null,
      avgEv: v.evN ? Math.round((v.evSum / v.evN) * 1000) / 1000 : null,
      reliable: v.picks >= MIN_RELIABLE_PICKS,
    }))
    .sort((a, b) => (b.beatRate ?? -Infinity) - (a.beatRate ?? -Infinity) || b.picks - a.picks);

  const marketScorecard: MarketScorecardRow[] = [...group(bets, (b) => b.statMarket).entries()]
    .map(([statMarket, rows]) => {
      const s = summarize(rows);
      return {
        statMarket,
        picks: s.n,
        beatRate: s.beatRate,
        avgEdge: s.avgEdge,
        avgEv: s.avgEv,
        hitRate: s.hitRate,
        reliable: s.n >= MIN_RELIABLE_PICKS,
      };
    })
    .filter((r) => r.picks > 0)
    .sort((a, b) => (b.beatRate ?? -Infinity) - (a.beatRate ?? -Infinity) || b.picks - a.picks);

  return {
    sampleSize: bets.length,
    gradedSample: overall.decided,
    withEv: bets.filter((b) => b.closeEvPercent !== null).length,
    overall: {
      beatRate: overall.beatRate,
      avgEdge: overall.avgEdge,
      avgEv: overall.avgEv,
      hitRate: overall.hitRate,
      wins: overall.wins,
      losses: overall.losses,
    },
    expectation: expectation(bets),
    clvVsResult: {
      overall: crosstab("All picks", bets),
      bySport: [...group(bets, (b) => b.sport).entries()]
        .map(([sport, rows]) => crosstab(sport, rows))
        .filter((b) => b.beat.n + b.missed.n >= minSample)
        .sort((a, b) => (b.lift ?? -Infinity) - (a.lift ?? -Infinity)),
    },
    byStat: toPropRows(group(bets, (b) => b.statMarket)),
    bySport: toPropRows(group(bets, (b) => b.sport)),
    bySide,
    worstBooks: toBookRows(bookTotals),
    worstBooksByStat: [...bookByStat.entries()]
      .map(([stat, map]) => ({ stat, books: toBookRows(map) }))
      .sort((a, b) => b.books.length - a.books.length),
    bookScorecard,
    marketScorecard,
    timing: timingBuckets(bets),
    edgeHistogram: edgeHistogram(bets),
  };
}
