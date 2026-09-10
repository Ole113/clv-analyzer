import type { ParsedRow, MarketType } from "@clv/shared";
import { prisma } from "./prisma";
import { buildMatchKey } from "./matching";
import { buildClosingVerdict } from "./closing";
import { evPercent } from "./ev";
import { devigTwoWay } from "@clv/shared";
import { scheduledFetchAtFor, type Status } from "./constants";

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

/**
 * Real book icons, keyed the same way `BOOK_LABELS` is, so generated rows render the same
 * "logo next to the book" treatment as a real capture instead of leaving the cell blank. Routed
 * through Google's favicon proxy rather than guessing at each book's own CDN path, since that path
 * is scraped from the live DOM on a real capture and nothing in this repo has a stable copy of it.
 */
const BOOK_LOGOS: Record<string, string> = {
  prizepicks: "https://www.google.com/s2/favicons?sz=64&domain=prizepicks.com",
  fanduel: "https://www.google.com/s2/favicons?sz=64&domain=fanduel.com",
  draftkings: "https://www.google.com/s2/favicons?sz=64&domain=draftkings.com",
  pinnacle: "https://www.google.com/s2/favicons?sz=64&domain=pinnacle.com",
  caesars: "https://www.google.com/s2/favicons?sz=64&domain=caesars.com",
  betmgm: "https://www.google.com/s2/favicons?sz=64&domain=betmgm.com",
  fanatics: "https://www.google.com/s2/favicons?sz=64&domain=fanatics.com",
};

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
  logoUrl: BOOK_LOGOS[bookKey] ?? null,
  liquidity,
  fairProbability: otherPrice === null ? null : devigTwoWay(price, otherPrice),
  rawText: `${line ?? ""} ${price}`.trim(),
});

/**
 * Every real sportsbook line on a totals-style market (a stat threshold, a spread) sits on a half
 * point -- never a whole number -- specifically so the market can never push. Snapping every
 * generated line here is also what keeps a stat's decimal sane: a made-up "12.2 rebounds" line
 * (a whole-number-only stat wandering off its .5 grid) doesn't happen on a real book, and it isn't
 * a case worth reproducing in test data either.
 */
function toHalfLine(value: number): number {
  return Math.floor(value) + 0.5;
}

/** A plausible opposite-side American-odds price, for de-vigging a moneyline book's own price. */
function oppositeMoneylinePrice(price: number): number {
  return price < 0 ? Math.round(Math.abs(price) * 0.88) : -Math.round(price * 1.12);
}

/**
 * Lead times spread across every bucket of the timing curve.
 *
 * The generator used to capture every pick exactly five hours before kickoff, which put the whole
 * sample in one column and made the curve look broken rather than empty. Cycling these gives each
 * bucket something in it without pretending to a realistic distribution.
 */
const LEAD_HOURS = [0.4, 2, 5, 12, 40, 100];

/**
 * Player-prop templates, spread across every sport that has a real PropProfessor market alias
 * (see `shared/src/markets.ts`) so the generated set exercises more than football and basketball.
 */
/**
 * `prob` is each template's own "% chance to hit" as OddsJam/PropProfessor would display it at
 * capture time -- real captures cluster tightly between 54.8% and 57%, so the generated set is
 * held to that band too rather than spanning the much wider range a devigged probability could
 * theoretically take.
 */
const TEMPLATES = [
  { sport: "NFL", stat: "Player Receiving Yards", player: "Test Player Rec A", taken: 62.5, drift: 4.5, prob: 0.549 },
  { sport: "NFL", stat: "Player Receiving Yards", player: "Test Player Rec B", taken: 71.5, drift: 2.0, prob: 0.553 },
  { sport: "NFL", stat: "Player Rushing Yards", player: "Test Player Rush A", taken: 58.5, drift: -3.5, prob: 0.557 },
  { sport: "NFL", stat: "Player Rushing Yards", player: "Test Player Rush B", taken: 74.5, drift: -5.0, prob: 0.561 },
  { sport: "NFL", stat: "Player Passing Yards", player: "Test Player Pass A", taken: 244.5, drift: 6.0, prob: 0.565 },
  { sport: "NFL", stat: "Player Passing Yards", player: "Test Player Pass B", taken: 219.5, drift: -8.0, prob: 0.569 },
  { sport: "NBA", stat: "Player Points", player: "Test Player Points A", taken: 26.5, drift: 1.5, prob: 0.55 },
  { sport: "NBA", stat: "Player Points", player: "Test Player Points B", taken: 24.5, drift: 2.5, prob: 0.554 },
  { sport: "NBA", stat: "Player Rebounds", player: "Test Player Reb A", taken: 12.5, drift: -1.5, prob: 0.558 },
  { sport: "NBA", stat: "Player Three Pointers Made", player: "Test Player 3PM A", taken: 3.5, drift: 0.5, prob: 0.562 },
  { sport: "MLB", stat: "Hits + Runs + RBIs", player: "Test Player HRR A", taken: 1.5, drift: -0.5, prob: 0.566 },
  { sport: "MLB", stat: "Player Strikeouts", player: "Test Pitcher A", taken: 6.5, drift: 1.5, prob: 0.548 },
  { sport: "NHL", stat: "Player Shots On Goal", player: "Test Player Shots A", taken: 3.5, drift: 0.5, prob: 0.556 },
  { sport: "NHL", stat: "Player Saves", player: "Test Goalie A", taken: 27.5, drift: -2.0, prob: 0.56 },
  { sport: "Tennis", stat: "Player Aces", player: "Test Server A", taken: 8.5, drift: 1.5, prob: 0.564 },
  { sport: "Tennis", stat: "Player Breakpoints Won", player: "Test Returner A", taken: 3.5, drift: -0.5, prob: 0.568 },
] as const;

/**
 * Markets no sportsbook prices (see `NO_SPORTSBOOK_EQUIVALENT` in `shared/src/markets.ts`), kept
 * separate from `TEMPLATES` because they are always terminal at `NO_CLOSING_MARKET` rather than
 * ever getting a real close -- mixing them into the normal win/loss/open cycle used to fabricate a
 * closing read for a market that, on a real screen, could never produce one.
 */
const FANTASY_ONLY_TEMPLATES = [
  { sport: "NFL", stat: "Fantasy Score (PrizePicks)", player: "Test Player Fantasy A", taken: 22, prob: 0.552 },
  { sport: "NFL", stat: "Fantasy Score (PrizePicks)", player: "Test Player Fantasy B", taken: 17.5, prob: 0.567 },
] as const;

/** Whole-game markets: no player, a team (or nothing, for totals) carries the identity instead. */
const GAME_TEMPLATES = [
  { sport: "NFL", marketType: "SPREAD" as const, team: "Test Chiefs", opponent: "Test Bills", taken: -5.5, drift: -1.5 },
  // Positive here (unlike the Chiefs line above) so the spread/moneyline generated set has both a
  // "beat" and an "against" case rather than always drifting the same direction.
  { sport: "NBA", marketType: "SPREAD" as const, team: "Test Celtics", opponent: "Test Knicks", taken: 3.5, drift: 2.0 },
  { sport: "NFL", marketType: "MONEYLINE" as const, team: "Test Ravens", opponent: "Test Steelers", taken: -145, drift: -25 },
  { sport: "NHL", marketType: "MONEYLINE" as const, team: "Test Oilers", opponent: "Test Jets", taken: 128, drift: 40 },
  { sport: "NBA", marketType: "GAME_TOTAL" as const, team: "Test Suns", opponent: "Test Nuggets", taken: 224.5, drift: 4.5 },
  { sport: "NFL", marketType: "GAME_TOTAL" as const, team: "Test Cowboys", opponent: "Test Eagles", taken: 47.5, drift: -3.0 },
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

interface PickSpec {
  site: "ODDSJAM";
  fantasyBook: string;
  pageUrl: string;
  marketType: MarketType;
  sport: string;
  statMarket: string;
  player: string | null;
  subjectTeam: string | null;
  selectionName: string | null;
  matchup: string;
  side: "OVER" | "UNDER" | null;
  takenLine: number;
  /**
   * Signed movement (in line units, or price units for a moneyline) from the template, carried
   * through to the close so a pick's outcome reflects the direction the template actually chose --
   * not a fixed per-market-type formula, which would put every pick's edge on the same side.
   */
  drift: number;
  fairProbability: number;
  fantasyPrice: number;
  gameStartTime: Date;
  openBooks: ReturnType<typeof book>[];
}

interface PlayerPropTemplate {
  sport: string;
  stat: string;
  player: string;
  taken: number;
  drift: number;
  prob: number;
}

/** A player-prop pick built from a template (either `TEMPLATES` or `FANTASY_ONLY_TEMPLATES`). */
function playerPropSpec(
  t: PlayerPropTemplate,
  side: "OVER" | "UNDER",
  gameStartTime: Date,
  matchup: string
): PickSpec {
  return {
    site: "ODDSJAM",
    fantasyBook: "prizepicks",
    pageUrl: "https://fantasy.oddsjam.com/fantasy-odds/prizepicks",
    marketType: "PLAYER_PROP",
    sport: t.sport,
    statMarket: t.stat,
    player: t.player,
    subjectTeam: null,
    selectionName: null,
    matchup,
    side,
    takenLine: t.taken,
    drift: t.drift,
    fairProbability: t.prob,
    fantasyPrice: -119,
    gameStartTime,
    openBooks: [
      book("prizepicks", "PrizePicks", null, -119),
      book("fanduel", "FanDuel", toHalfLine(t.taken + t.drift * 0.3), -114),
      book("pinnacle", "Pinnacle", toHalfLine(t.taken + t.drift * 0.4), -112),
    ],
  };
}

/** A whole-game pick (spread, moneyline or total) built from one of `GAME_TEMPLATES`. */
function gameMarketSpec(
  t: (typeof GAME_TEMPLATES)[number],
  side: "OVER" | "UNDER",
  gameStartTime: Date
): PickSpec {
  const matchup = `${t.team} vs ${t.opponent}`;
  const isMoneyline = t.marketType === "MONEYLINE";
  const isTotal = t.marketType === "GAME_TOTAL";
  const selectionName = isMoneyline
    ? `${t.team} ML`
    : isTotal
      ? `Total ${side === "UNDER" ? "Under" : "Over"} ${t.taken}`
      : `${t.team} ${t.taken > 0 ? "+" : ""}${t.taken}`;

  const openLine = isMoneyline ? t.taken + 15 : toHalfLine(t.taken + t.drift * 0.3);
  const openOther = isMoneyline ? oppositeMoneylinePrice(openLine) : -110;

  return {
    site: "ODDSJAM",
    // Whole-game markets come off OddsJam's rebet/fliff boards, not the fantasy DFS boards.
    fantasyBook: "rebet",
    pageUrl: "https://fantasy.oddsjam.com/fantasy-odds/rebet",
    marketType: t.marketType,
    sport: t.sport,
    statMarket: isMoneyline ? "Moneyline" : isTotal ? "Game Total" : "Point Spread",
    player: null,
    subjectTeam: isTotal ? null : t.team,
    selectionName,
    matchup,
    side: isTotal ? side : null,
    takenLine: t.taken,
    drift: t.drift,
    fairProbability: 0.56,
    fantasyPrice: -119,
    gameStartTime,
    openBooks: [
      book("fanduel", "FanDuel", openLine, isMoneyline ? openLine : -110, openOther),
      book("pinnacle", "Pinnacle", openLine, isMoneyline ? openLine : -108, openOther),
    ],
  };
}

/** Closing book lines matching `spec`'s market shape, cycling the usual per-book bias/outlier setup. */
function closingBooksFor(
  spec: PickSpec,
  i: number,
  consensus: number
): ReturnType<typeof book>[] {
  const isMoneyline = spec.marketType === "MONEYLINE";
  // Every sixth pick gets a book hanging a number far outside the field, so the outlier
  // rejection -- and therefore the exclusions page -- has something real to show.
  // Stride 7 rather than 6: there are more than 12 templates in circulation, so any stride sharing
  // a factor with the template count would land the outlier on the same market every time.
  const plantOutlier = i % 7 === 6;

  return [
    ...Object.entries(BOOK_BIAS).map(([key, bias], b) => {
      const line = isMoneyline ? Math.round(consensus + bias * 20) : toHalfLine(consensus + bias);
      const price = isMoneyline ? line : -112;
      // Two-sided on most books but not all, mirroring a real screen read where only some books
      // price the side taken -- which is what makes fairBookCount < closingBookCount.
      const other = b % 3 === 2 ? null : isMoneyline ? oppositeMoneylinePrice(line) : -108;
      return book(key, BOOK_LABELS[key] ?? key, line, price, other, key === "pinnacle" ? 1200 : 0);
    }),
    ...(plantOutlier
      ? // Proportional, not a fixed offset: the outlier band has a floor at 10% of the line, so
        // what counts as "far from the field" is a different number on a 1.5-strikeout prop and a
        // 244.5-passing-yards prop.
        [
          book(
            "fanatics",
            "Fanatics",
            isMoneyline ? Math.round(consensus * 1.9) : toHalfLine(consensus * 1.9),
            -900
          ),
        ]
      : []),
  ];
}

/** Builds and writes one pick that either closes normally or is left open (PENDING). */
async function createPick(spec: PickSpec, i: number, leaveOpen: boolean): Promise<void> {
  const openRow = row({
    fairProbability: spec.fairProbability,
    player: spec.player,
    subjectTeam: spec.subjectTeam,
    selectionName: spec.selectionName,
    statMarket: spec.statMarket,
    marketType: spec.marketType,
    side: spec.side,
    sport: spec.sport,
    takenLine: spec.takenLine,
    matchup: spec.matchup,
    bookLines: spec.openBooks,
  });

  // Signed by the template, not derived from the taken line's magnitude -- that would move every
  // closing consensus the same direction and make every pick's edge come out the same sign, which
  // is exactly the "every prop reads Against You" bug this replaced.
  const consensus = spec.takenLine + spec.drift;
  const closeBooks = leaveOpen ? null : closingBooksFor(spec, i, consensus);

  const verdict = closeBooks
    ? buildClosingVerdict(
        spec.marketType,
        spec.side,
        spec.takenLine,
        row({ ...openRow, bookLines: closeBooks }),
        null,
        // The screen path, matching how closing reads actually happen now: it is the one that runs
        // the outlier test, so the optimizer default would never produce an exclusion.
        "PP_SCREEN",
        { openFairProb: spec.fairProbability }
      )
    : null;

  await prisma.bet.create({
    data: {
      site: spec.site,
      fantasyBook: spec.fantasyBook,
      marketType: spec.marketType,
      sport: spec.sport,
      player: spec.player,
      subjectTeam: spec.subjectTeam,
      selectionName: spec.selectionName,
      matchup: spec.matchup,
      statMarket: spec.statMarket,
      side: spec.side,
      gameStartTime: spec.gameStartTime,
      matchKey: buildMatchKey({
        site: spec.site,
        fantasyBook: spec.fantasyBook,
        marketType: spec.marketType,
        subjectTeam: spec.subjectTeam,
        sport: spec.sport,
        player: spec.player,
        statMarket: spec.statMarket,
        side: spec.side,
        takenLine: spec.takenLine,
        gameStartTime: spec.gameStartTime,
      }),
      pageUrl: spec.pageUrl,
      sourceDevice: TEST_DATA_DEVICE,
      takenLine: spec.takenLine,
      openFairProb: spec.fairProbability,
      fantasyPrice: spec.fantasyPrice,
      openEvPercent: evPercent(spec.fairProbability, spec.fantasyPrice),
      openRawSnapshotJson: JSON.stringify(openRow),
      openCapturedAt: new Date(
        spec.gameStartTime.getTime() - LEAD_HOURS[i % LEAD_HOURS.length] * 3600_000
      ),
      scheduledFetchAt: scheduledFetchAtFor(spec.gameStartTime),
      // Liquidity and per-book fair probability are dropped here rather than carried across: they
      // come from the odds screen's JSON, and OpenLine has no columns for them because the
      // capture-time boards are scraped DOM that never shows either. Real ingestion strips them at
      // the zod boundary; this keeps the generator honest about the same asymmetry.
      openLines: {
        create: spec.openBooks.map(({ liquidity: _liquidity, fairProbability: _fair, ...b }) => ({
          ...b,
          includedInAverage: true,
        })),
      },
      ...(verdict
        ? {
            status: verdict.status,
            closeCapturedAt: new Date(spec.gameStartTime.getTime() + 2 * 60_000),
            closeRawSnapshotJson: JSON.stringify({ ...openRow, bookLines: closeBooks }),
            avgClosingLine: verdict.avgClosingLine,
            closingBookCount: verdict.closingBookCount,
            closeFairProb: verdict.closeFairProb ?? spec.fairProbability,
            closeEvPercent: evPercent(verdict.closeFairProb ?? spec.fairProbability, spec.fantasyPrice),
            edge: verdict.edge,
            beatClv: verdict.beatClv,
            priceEdge: verdict.priceEdge,
            excludedBooks: verdict.excludedBooks.length ? JSON.stringify(verdict.excludedBooks) : null,
            closingSourceSite: "PROPPROFESSOR_SCREEN",
            closingMethod: verdict.closingSource,
            closeLines: { create: verdict.closeLines },
          }
        : { status: "PENDING" as const }),
    },
  });
}

/**
 * Builds and writes a pick that never reaches a normal close -- one of the terminal or in-flight
 * statuses a real slate produces outside the win/loss/open cycle, so those states have something
 * to look at on the dashboard too instead of only appearing the first time a real one occurs.
 */
async function createSpecialStatusPick(
  spec: PickSpec,
  i: number,
  status: Extract<Status, "NEEDS_GAME_TIME" | "LIVE_NO_CLV" | "UNAVAILABLE" | "FETCH_FAILED" | "DUE" | "NO_CLOSING_MARKET">
): Promise<void> {
  const openRow = row({
    fairProbability: spec.fairProbability,
    player: spec.player,
    subjectTeam: spec.subjectTeam,
    selectionName: spec.selectionName,
    statMarket: spec.statMarket,
    marketType: spec.marketType,
    side: spec.side,
    sport: spec.sport,
    takenLine: spec.takenLine,
    matchup: spec.matchup,
    isLive: status === "LIVE_NO_CLV",
    bookLines: spec.openBooks,
  });

  const gameStartTime = status === "NEEDS_GAME_TIME" ? null : spec.gameStartTime;

  await prisma.bet.create({
    data: {
      site: spec.site,
      fantasyBook: spec.fantasyBook,
      marketType: spec.marketType,
      sport: spec.sport,
      player: spec.player,
      subjectTeam: spec.subjectTeam,
      selectionName: spec.selectionName,
      matchup: spec.matchup,
      statMarket: spec.statMarket,
      side: spec.side,
      isLive: status === "LIVE_NO_CLV",
      gameStartTime,
      matchKey: buildMatchKey({
        site: spec.site,
        fantasyBook: spec.fantasyBook,
        marketType: spec.marketType,
        subjectTeam: spec.subjectTeam,
        sport: spec.sport,
        player: spec.player,
        statMarket: spec.statMarket,
        side: spec.side,
        takenLine: spec.takenLine,
        gameStartTime,
      }),
      pageUrl: spec.pageUrl,
      sourceDevice: TEST_DATA_DEVICE,
      takenLine: spec.takenLine,
      openFairProb: spec.fairProbability,
      fantasyPrice: spec.fantasyPrice,
      openEvPercent: evPercent(spec.fairProbability, spec.fantasyPrice),
      openRawSnapshotJson: JSON.stringify(openRow),
      openCapturedAt: new Date(
        (spec.gameStartTime.getTime()) - LEAD_HOURS[i % LEAD_HOURS.length] * 3600_000
      ),
      scheduledFetchAt: gameStartTime ? scheduledFetchAtFor(gameStartTime) : null,
      openLines: {
        create: spec.openBooks.map(({ liquidity: _liquidity, fairProbability: _fair, ...b }) => ({
          ...b,
          includedInAverage: true,
        })),
      },
      status,
      ...(status === "FETCH_FAILED"
        ? {
            fetchAttempts: 6,
            lastFetchError: "Timed out waiting for PropProfessor's odds screen to load",
            lastFetchAt: new Date(spec.gameStartTime.getTime() - 3 * 60_000),
          }
        : {}),
      ...(status === "DUE"
        ? { scheduledFetchAt: new Date(Date.now() - 2 * 60_000), fetchAttempts: 1 }
        : {}),
      ...(status === "UNAVAILABLE"
        ? {
            closeCapturedAt: new Date(spec.gameStartTime.getTime() + 2 * 60_000),
            lastFetchError: "Selection not offered on the closing board (scratched or pulled)",
          }
        : {}),
    },
  });
}

/**
 * Creates `count` synthetic picks tagged as test data, cycling through a fixed set of templates.
 *
 * Each one gets its own game start time (spaced a few minutes apart) so the matchKey -- which
 * includes the taken line and start time -- never collides across a batch, no matter how many are
 * requested.
 *
 * The cycle spends most of its slots on player props (several sports, both sides, a mix of
 * wins/losses/opens/outliers -- the everyday case) but 1 in 20 picks lands on a deliberately
 * different case: a whole-game spread/moneyline/total, or one of the non-CLOSED terminal statuses
 * (NEEDS_GAME_TIME, LIVE_NO_CLV, UNAVAILABLE, FETCH_FAILED, DUE, NO_CLOSING_MARKET) a real slate
 * produces outside the normal win/loss/open cycle. That way a small load still has at least one of
 * everything to look at, and a large one has a realistic mix.
 */
export async function generateTestData(count: number): Promise<number> {
  const n = Math.max(1, Math.min(MAX_TEST_DATA_PER_REQUEST, Math.floor(count) || 0));
  const now = Date.now();

  for (let i = 0; i < n; i++) {
    // Spread a few minutes apart, oldest first, so every generated pick's matchKey is unique.
    const gameStartTime = new Date(now - (n - i) * 4 * 60_000 - 3600_000);
    const side = i % 3 === 2 ? ("UNDER" as const) : ("OVER" as const);
    const slot = i % 20;

    if (slot === 11) {
      const t = TEMPLATES[i % TEMPLATES.length];
      await createSpecialStatusPick(
        playerPropSpec(t, side, gameStartTime, `Test matchup ${i + 1}`),
        i,
        "NEEDS_GAME_TIME"
      );
    } else if (slot === 12) {
      const t = TEMPLATES[i % TEMPLATES.length];
      await createSpecialStatusPick(
        playerPropSpec(t, side, gameStartTime, `Test matchup ${i + 1}`),
        i,
        "LIVE_NO_CLV"
      );
    } else if (slot === 13) {
      const t = TEMPLATES[i % TEMPLATES.length];
      await createSpecialStatusPick(
        playerPropSpec(t, side, gameStartTime, `Test matchup ${i + 1}`),
        i,
        "UNAVAILABLE"
      );
    } else if (slot === 14) {
      const t = TEMPLATES[i % TEMPLATES.length];
      await createSpecialStatusPick(
        playerPropSpec(t, side, gameStartTime, `Test matchup ${i + 1}`),
        i,
        "FETCH_FAILED"
      );
    } else if (slot === 15) {
      const t = TEMPLATES[i % TEMPLATES.length];
      await createSpecialStatusPick(
        playerPropSpec(t, side, gameStartTime, `Test matchup ${i + 1}`),
        i,
        "DUE"
      );
    } else if (slot === 16) {
      const t = FANTASY_ONLY_TEMPLATES[i % FANTASY_ONLY_TEMPLATES.length];
      await createSpecialStatusPick(
        playerPropSpec(
          { ...t, drift: 0 },
          side,
          gameStartTime,
          `Test matchup ${i + 1}`
        ),
        i,
        "NO_CLOSING_MARKET"
      );
    } else if (slot === 17 || slot === 18 || slot === 19) {
      const gameTemplates = GAME_TEMPLATES.filter((g) =>
        slot === 17 ? g.marketType === "SPREAD" : slot === 18 ? g.marketType === "MONEYLINE" : g.marketType === "GAME_TOTAL"
      );
      const t = gameTemplates[i % gameTemplates.length];
      const leaveOpen = i % 9 === 8;
      await createPick(gameMarketSpec(t, side, gameStartTime), i, leaveOpen);
    } else {
      const t = TEMPLATES[i % TEMPLATES.length];
      // Every fourth pick is left PENDING rather than closed, so the open state is exercised too,
      // not just closed picks with a verdict.
      const leaveOpen = i % 4 === 3;
      await createPick(playerPropSpec(t, side, gameStartTime, `Test matchup ${i + 1}`), i, leaveOpen);
    }
  }

  return n;
}
