/**
 * Inserts a few illustrative picks so the dashboard is not empty before real captures arrive.
 *
 *   npx tsx src/scripts/seed-demo.ts          # add demo rows
 *   npx tsx src/scripts/seed-demo.ts --clear  # remove them again
 *
 * Everything it creates is tagged sourceDevice="demo-seed" so it can be removed cleanly and is
 * easy to tell apart from real picks.
 */
import { PrismaClient } from "@prisma/client";
import { buildMatchKey } from "../lib/matching";
import { buildClosingVerdict } from "../lib/closing";
import { evPercent } from "../lib/ev";
import type { ParsedRow } from "@clv/shared";

const prisma = new PrismaClient();
const DEVICE = "demo-seed";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

function row(over: Partial<ParsedRow>): ParsedRow {
  return {
    rowIndex: 0,
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

const book = (bookKey: string, label: string, line: number | null, price: number) => ({
  bookKey,
  label,
  line,
  price,
  rawText: `${line ?? ""} ${price}`.trim(),
});

async function main() {
  if (process.argv.includes("--clear")) {
    const { count } = await prisma.bet.deleteMany({ where: { sourceDevice: DEVICE } });
    console.log(`Removed ${count} demo picks.`);
    return;
  }

  // A spread wide enough to exercise the analysis page: several prop types and sports, a mix of
  // sides, and per-book closing lines that scatter around the consensus.
  const templates = [
    { sport: "NFL", stat: "Player Receiving Yards", player: "Puka Nacua", taken: 62.5, drift: 4.5, prob: 0.58 },
    { sport: "NFL", stat: "Player Receiving Yards", player: "CeeDee Lamb", taken: 71.5, drift: 2.0, prob: 0.56 },
    { sport: "NFL", stat: "Player Rushing Yards", player: "Bijan Robinson", taken: 58.5, drift: -3.5, prob: 0.52 },
    { sport: "NFL", stat: "Player Rushing Yards", player: "Saquon Barkley", taken: 74.5, drift: -5.0, prob: 0.51 },
    { sport: "NFL", stat: "Player Passing Yards", player: "Jared Goff", taken: 244.5, drift: 6.0, prob: 0.59 },
    { sport: "NFL", stat: "Player Passing Yards", player: "Jalen Hurts", taken: 219.5, drift: -8.0, prob: 0.5 },
    { sport: "NFL", stat: "Fantasy Score (PrizePicks)", player: "Jahmyr Gibbs", taken: 22, drift: -2.7, prob: 0.55 },
    { sport: "NFL", stat: "Fantasy Score (PrizePicks)", player: "Matthew Stafford", taken: 17.5, drift: -1.2, prob: 0.53 },
    { sport: "NBA", stat: "Player Points", player: "Anthony Edwards", taken: 26.5, drift: 1.5, prob: 0.57 },
    { sport: "NBA", stat: "Player Points", player: "Jalen Brunson", taken: 24.5, drift: 2.5, prob: 0.6 },
    { sport: "NBA", stat: "Player Rebounds", player: "Domantas Sabonis", taken: 12.5, drift: -1.1, prob: 0.49 },
    { sport: "MLB", stat: "Hits + Runs + RBIs", player: "Pete Alonso", taken: 1.5, drift: -0.4, prob: 0.48 },
  ];

  // Books scatter consistently: some habitually hang a worse number than the market.
  const BOOK_LABELS: Record<string, string> = {
    fanduel: "FanDuel",
    draftkings: "DraftKings",
    pinnacle: "Pinnacle",
    caesars: "Caesars",
    betmgm: "BetMGM",
  };
  const bookBias: Record<string, number> = {
    fanduel: 0.15,
    draftkings: -0.1,
    pinnacle: 0.35,
    caesars: -0.45,
    betmgm: -0.25,
  };

  const specs = templates.map((t, i) => {
    const side = i % 3 === 2 ? ("UNDER" as const) : ("OVER" as const);
    const consensus = t.taken + t.drift;
    const closeBooks = Object.entries(bookBias).map(([key, bias]) =>
      book(key, BOOK_LABELS[key] ?? key, Math.round((consensus + bias) * 10) / 10, -112)
    );
    return {
      player: t.player,
      statMarket: t.stat,
      side,
      sport: t.sport,
      taken: t.taken,
      matchup: `${t.sport} matchup ${i + 1}`,
      fairProb: t.prob,
      openBooks: [
        book("prizepicks", "PrizePicks", null, -119),
        book("fanduel", "FanDuel", Math.round((t.taken + t.drift * 0.3) * 10) / 10, -114),
        book("pinnacle", "Pinnacle", Math.round((t.taken + t.drift * 0.4) * 10) / 10, -112),
      ],
      closeBooks,
      startedHoursAgo: 12 + i * 5,
    };
  });

  for (const spec of specs) {
    const gameStartTime = hoursAgo(spec.startedHoursAgo);

    const openRow = row({
      fairProbability: spec.fairProb,
      player: spec.player,
      statMarket: spec.statMarket,
      side: spec.side,
      sport: spec.sport,
      takenLine: spec.taken,
      matchup: spec.matchup,
      bookLines: spec.openBooks,
    });

    const verdict = spec.closeBooks
      ? buildClosingVerdict(spec.side, spec.taken, row({ ...openRow, bookLines: spec.closeBooks }))
      : null;

    await prisma.bet.create({
      data: {
        site: "ODDSJAM",
        fantasyBook: "prizepicks",
        sport: spec.sport,
        player: spec.player,
        matchup: spec.matchup,
        statMarket: spec.statMarket,
        side: spec.side,
        gameStartTime,
        matchKey: buildMatchKey({
          site: "ODDSJAM",
          fantasyBook: "prizepicks",
          sport: spec.sport,
          player: spec.player,
          statMarket: spec.statMarket,
          side: spec.side,
          gameStartTime,
        }),
        pageUrl: "https://fantasy.oddsjam.com/fantasy-odds/prizepicks",
        sourceDevice: DEVICE,
        takenLine: spec.taken,
        openFairProb: spec.fairProb,
        fantasyPrice: -119,
        openEvPercent: evPercent(spec.fairProb, -119),
        openRawSnapshotJson: JSON.stringify(openRow),
        openCapturedAt: new Date(gameStartTime.getTime() - 5 * 3600_000),
        scheduledFetchAt: new Date(gameStartTime.getTime() + 2 * 60_000),
        openLines: {
          create: spec.openBooks.map((b) => ({
            ...b,
            includedInAverage: true,
          })),
        },
        ...(verdict
          ? {
              status: verdict.status,
              closeCapturedAt: new Date(gameStartTime.getTime() + 2 * 60_000),
              closeRawSnapshotJson: JSON.stringify({ ...openRow, bookLines: spec.closeBooks }),
              avgClosingLine: verdict.avgClosingLine,
              closingBookCount: verdict.closingBookCount,
              closeFairProb: spec.fairProb,
              closeEvPercent: evPercent(spec.fairProb, -119),
              edge: verdict.edge,
              beatClv: verdict.beatClv,
              closeLines: { create: verdict.closeLines },
            }
          : { status: "PENDING" }),
      },
    });
  }

  console.log(`Seeded ${specs.length} demo picks. Remove them with: npx tsx src/scripts/seed-demo.ts --clear`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
