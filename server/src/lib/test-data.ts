import type { ParsedRow } from "@clv/shared";
import { prisma } from "./prisma";
import { buildMatchKey } from "./matching";
import { buildClosingVerdict } from "./closing";
import { evPercent } from "./ev";
import { devigTwoWay } from "@clv/shared";
import { scheduledFetchAtFor } from "./constants";

/**
 * Tags synthetic rows so they can be told apart from real captures and deleted on their own.
 * "demo-seed" is the older tag from the CLI seed script (src/scripts/seed-demo.ts); rows created
 * from Settings carry "test-data". Both are treated as the same thing everywhere a caller needs to
 * find or purge test rows, so picks seeded before this UI existed are still cleanable from it.
 */
export const TEST_DATA_DEVICE = "test-data";
export const TEST_DATA_SOURCE_DEVICES = [TEST_DATA_DEVICE, "demo-seed"];

/** Generating thousands of fake rows by accident would be its own kind of bug. */
export const MAX_TEST_DATA_PER_REQUEST = 500;

function row(over: Partial<ParsedRow>): ParsedRow {
  return {
    rowIndex: 0,
    marketType: "PLAYER_PROP",
    selectionName: null,
    subjectTeam: null,
    isLive: false,
    boardEvPercent: null,
    player: "Player",
    team: null,
    opponent: null,
    matchup: null,
    sport: "NFL",
    statMarket: "Fantasy Score",
    side: "OVER",
    takenLine: 10,
    fairProbability: 0.58,
    gameStartTimeText: null,
    gameStartTimeIso: null,
    externalPropId: null,
    externalPlayerId: null,
    bookLines: [],
    rawText: "",
    ...over,
  };
}

const book = (
  bookKey: string,
  label: string,
  line: number | null,
  price: number,
  /** The opposite side's price, so the row can be de-vigged the way a real screen read is. */
  otherPrice: number | null = null,
  liquidity: number | null = 0
) => ({
  bookKey,
  label,
  line,
  price,
  logoUrl: null,
  liquidity,
  fairProbability: otherPrice === null ? null : devigTwoWay(price, otherPrice),
  rawText: `${line ?? ""} ${price}`.trim(),
});

/**
 * Lead times spread across every bucket of the timing curve.
 *
 * The generator used to capture every pick exactly five hours before kickoff, which put the whole
 * sample in one column and made the curve look broken rather than empty. Cycling these gives each
 * bucket something in it without pretending to a realistic distribution.
 */
const LEAD_HOURS = [0.4, 2, 5, 12, 40, 100];

/** Wide enough to exercise the analysis page: several prop types, sports, and sides. */
const TEMPLATES = [
  { sport: "NFL", stat: "Player Receiving Yards", player: "Test Player Rec A", taken: 62.5, drift: 4.5, prob: 0.58 },
  { sport: "NFL", stat: "Player Receiving Yards", player: "Test Player Rec B", taken: 71.5, drift: 2.0, prob: 0.56 },
  { sport: "NFL", stat: "Player Rushing Yards", player: "Test Player Rush A", taken: 58.5, drift: -3.5, prob: 0.52 },
  { sport: "NFL", stat: "Player Rushing Yards", player: "Test Player Rush B", taken: 74.5, drift: -5.0, prob: 0.51 },
  { sport: "NFL", stat: "Player Passing Yards", player: "Test Player Pass A", taken: 244.5, drift: 6.0, prob: 0.59 },
  { sport: "NFL", stat: "Player Passing Yards", player: "Test Player Pass B", taken: 219.5, drift: -8.0, prob: 0.5 },
  { sport: "NFL", stat: "Fantasy Score (PrizePicks)", player: "Test Player Fantasy A", taken: 22, drift: -2.7, prob: 0.55 },
  { sport: "NFL", stat: "Fantasy Score (PrizePicks)", player: "Test Player Fantasy B", taken: 17.5, drift: -1.2, prob: 0.53 },
  { sport: "NBA", stat: "Player Points", player: "Test Player Points A", taken: 26.5, drift: 1.5, prob: 0.57 },
  { sport: "NBA", stat: "Player Points", player: "Test Player Points B", taken: 24.5, drift: 2.5, prob: 0.6 },
  { sport: "NBA", stat: "Player Rebounds", player: "Test Player Reb A", taken: 12.5, drift: -1.1, prob: 0.49 },
  { sport: "MLB", stat: "Hits + Runs + RBIs", player: "Test Player HRR A", taken: 1.5, drift: -0.4, prob: 0.48 },
] as const;

const BOOK_LABELS: Record<string, string> = {
  fanduel: "FanDuel",
  draftkings: "DraftKings",
  pinnacle: "Pinnacle",
  caesars: "Caesars",
  betmgm: "BetMGM",
};
const BOOK_BIAS: Record<string, number> = {
  fanduel: 0.15,
  draftkings: -0.1,
  pinnacle: 0.35,
  caesars: -0.45,
  betmgm: -0.25,
};

/**
 * Creates `count` synthetic picks tagged as test data, cycling through a fixed set of templates.
 * Each one gets its own game start time (spaced a few minutes apart) so the matchKey -- which now
 * includes the taken line and start time -- never collides across a batch, no matter how many are
 * requested. Every fourth pick is left PENDING rather than closed, so the open state is exercised
 * too, not just closed picks with a verdict.
 */
export async function generateTestData(count: number): Promise<number> {
  const n = Math.max(1, Math.min(MAX_TEST_DATA_PER_REQUEST, Math.floor(count) || 0));
  const now = Date.now();

  for (let i = 0; i < n; i++) {
    const t = TEMPLATES[i % TEMPLATES.length];
    const side = i % 3 === 2 ? ("UNDER" as const) : ("OVER" as const);
    const leaveOpen = i % 4 === 3;
    // Spread a few minutes apart, oldest first, so every generated pick's matchKey is unique.
    const gameStartTime = new Date(now - (n - i) * 4 * 60_000 - 3600_000);
    const matchup = `Test matchup ${i + 1}`;

    const openBooks = [
      book("prizepicks", "PrizePicks", null, -119),
      book("fanduel", "FanDuel", Math.round((t.taken + t.drift * 0.3) * 10) / 10, -114),
      book("pinnacle", "Pinnacle", Math.round((t.taken + t.drift * 0.4) * 10) / 10, -112),
    ];

    const openRow = row({
      fairProbability: t.prob,
      player: t.player,
      statMarket: t.stat,
      side,
      sport: t.sport,
      takenLine: t.taken,
      matchup,
      bookLines: openBooks,
    });

    const consensus = t.taken + t.drift;
    // Every sixth pick gets a book hanging a number far outside the field, so the outlier
    // rejection -- and therefore the exclusions page -- has something real to show.
    // Stride 7 rather than 6: there are 12 templates, so any stride sharing a factor with 12 would
    // land the outlier on the same prop type every time -- and on a 244.5 passing-yards line the
    // tolerance band is wide enough that a fixed offset would never be rejected at all.
    const plantOutlier = i % 7 === 6;
    const closeBooks = leaveOpen
      ? null
      : [
          ...Object.entries(BOOK_BIAS).map(([key, bias], b) =>
            book(
              key,
              BOOK_LABELS[key] ?? key,
              Math.round((consensus + bias) * 10) / 10,
              -112,
              // Two-sided on most books but not all, mirroring a real screen read where only some
              // books price the side taken -- which is what makes fairBookCount < closingBookCount.
              b % 3 === 2 ? null : -108,
              key === "pinnacle" ? 1200 : 0
            )
          ),
          ...(plantOutlier
            ? // Proportional, not a fixed offset: the outlier band has a floor at 10% of the line,
              // so what counts as "far from the field" is a different number on a 1.5 HRR prop and
              // a 244.5 passing-yards prop.
              [book("fanatics", "Fanatics", Math.round(consensus * 19) / 10, -900)]
            : []),
        ];

    const verdict = closeBooks
      ? buildClosingVerdict(
          "PLAYER_PROP",
          side,
          t.taken,
          row({ ...openRow, bookLines: closeBooks }),
          null,
          // The screen path, matching how closing reads actually happen now: it is the one that
          // runs the outlier test, so the optimizer default would never produce an exclusion.
          "PP_SCREEN",
          { openFairProb: t.prob }
        )
      : null;

    await prisma.bet.create({
      data: {
        site: "ODDSJAM",
        fantasyBook: "prizepicks",
        sport: t.sport,
        player: t.player,
        matchup,
        statMarket: t.stat,
        side,
        gameStartTime,
        matchKey: buildMatchKey({
          site: "ODDSJAM",
          fantasyBook: "prizepicks",
          marketType: "PLAYER_PROP",
          subjectTeam: null,
          sport: t.sport,
          player: t.player,
          statMarket: t.stat,
          side,
          takenLine: t.taken,
          gameStartTime,
        }),
        pageUrl: "https://fantasy.oddsjam.com/fantasy-odds/prizepicks",
        sourceDevice: TEST_DATA_DEVICE,
        takenLine: t.taken,
        openFairProb: t.prob,
        fantasyPrice: -119,
        openEvPercent: evPercent(t.prob, -119),
        openRawSnapshotJson: JSON.stringify(openRow),
        openCapturedAt: new Date(
          gameStartTime.getTime() - LEAD_HOURS[i % LEAD_HOURS.length] * 3600_000
        ),
        scheduledFetchAt: scheduledFetchAtFor(gameStartTime),
        // Liquidity and per-book fair probability are dropped here rather than carried across:
        // they come from the odds screen's JSON, and OpenLine has no columns for them because the
        // capture-time boards are scraped DOM that never shows either. Real ingestion strips them
        // at the zod boundary; this keeps the generator honest about the same asymmetry.
        openLines: {
          create: openBooks.map(({ liquidity: _liquidity, fairProbability: _fair, ...b }) => ({
            ...b,
            includedInAverage: true,
          })),
        },
        ...(verdict
          ? {
              status: verdict.status,
              closeCapturedAt: new Date(gameStartTime.getTime() + 2 * 60_000),
              closeRawSnapshotJson: JSON.stringify({ ...openRow, bookLines: closeBooks }),
              avgClosingLine: verdict.avgClosingLine,
              closingBookCount: verdict.closingBookCount,
              closeFairProb: verdict.closeFairProb ?? t.prob,
              closeEvPercent: evPercent(verdict.closeFairProb ?? t.prob, -119),
              edge: verdict.edge,
              beatClv: verdict.beatClv,
              priceEdge: verdict.priceEdge,
              excludedBooks: verdict.excludedBooks.length
                ? JSON.stringify(verdict.excludedBooks)
                : null,
              closingSourceSite: "PROPPROFESSOR_SCREEN",
              closingMethod: verdict.closingSource,
              closeLines: { create: verdict.closeLines },
            }
          : { status: "PENDING" }),
      },
    });
  }

  return n;
}
