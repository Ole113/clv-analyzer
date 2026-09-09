import { z } from "zod";
import { isSportsbookForAverage } from "@clv/shared";
import { evPercent, fantasyPriceFrom } from "./ev";
import { prisma } from "./prisma";
import { buildMatchKey } from "./matching";
import { config } from "./constants";

const bookLineSchema = z.object({
  bookKey: z.string().min(1),
  label: z.string().nullable(),
  line: z.number().nullable(),
  price: z.number().nullable(),
  rawText: z.string(),
});

const rowSchema = z.object({
  rowIndex: z.number(),
  player: z.string().min(1),
  team: z.string().nullable(),
  opponent: z.string().nullable(),
  matchup: z.string().nullable(),
  sport: z.string().nullable(),
  statMarket: z.string().min(1),
  side: z.enum(["OVER", "UNDER"]),
  takenLine: z.number(),
  fairProbability: z.number().nullable().optional().default(null),
  gameStartTimeText: z.string().nullable(),
  gameStartTimeIso: z.string().nullable(),
  externalPropId: z.string().nullable(),
  externalPlayerId: z.string().nullable(),
  bookLines: z.array(bookLineSchema),
  rawText: z.string(),
});

export const snapshotSchema = z.object({
  site: z.enum(["ODDSJAM", "PROPPROFESSOR"]),
  fantasyBook: z.string().min(1),
  pageUrl: z.string(),
  capturedAt: z.string(),
  sourceDevice: z.string().nullable().optional(),
  row: rowSchema,
  rawHtml: z.string().optional().default(""),
});

export type SnapshotInput = z.infer<typeof snapshotSchema>;

export async function ingestSnapshot(input: SnapshotInput) {
  const { row } = input;

  const gameStartTime = row.gameStartTimeIso ? new Date(row.gameStartTimeIso) : null;
  const validStart = gameStartTime && !Number.isNaN(gameStartTime.getTime()) ? gameStartTime : null;

  // Without a start time there is nothing to schedule against. The pick is still stored -- it is
  // flagged NEEDS_GAME_TIME so it can be fixed from the dashboard rather than silently guessed.
  const scheduledFetchAt = validStart
    ? new Date(validStart.getTime() + config.closingBufferMinutes * 60_000)
    : null;
  // First grading attempt a few hours after kickoff, once the box score is posted.
  const gradeScheduledAt = validStart
    ? new Date(validStart.getTime() + config.gradeDelayHours * 3600_000)
    : null;

  const matchKey = buildMatchKey({
    site: input.site,
    fantasyBook: input.fantasyBook,
    sport: row.sport,
    player: row.player,
    statMarket: row.statMarket,
    side: row.side,
    gameStartTime: validStart,
  });

  // Re-checking the same row should update the pick rather than double-count it in the stats.
  const existing = await prisma.bet.findFirst({
    where: { matchKey, status: { in: ["PENDING", "NEEDS_GAME_TIME", "DUE"] } },
  });

  const openLines = row.bookLines.map((b) => ({
    bookKey: b.bookKey,
    label: b.label,
    line: b.line,
    price: b.price,
    rawText: b.rawText,
    includedInAverage: isSportsbookForAverage(b.bookKey, b.label, typeof b.line === "number"),
  }));

  const data = {
    site: input.site,
    fantasyBook: input.fantasyBook.toLowerCase(),
    sport: row.sport,
    player: row.player,
    team: row.team,
    opponent: row.opponent,
    matchup: row.matchup,
    statMarket: row.statMarket,
    side: row.side,
    gameStartTime: validStart,
    gameStartTimeText: row.gameStartTimeText,
    externalPropId: row.externalPropId,
    matchKey,
    pageUrl: input.pageUrl,
    sourceDevice: input.sourceDevice ?? null,
    takenLine: row.takenLine,
    openFairProb: row.fairProbability,
    fantasyPrice: fantasyPriceFrom(row.bookLines),
    openEvPercent: evPercent(row.fairProbability, fantasyPriceFrom(row.bookLines)),
    openRawSnapshotJson: JSON.stringify(row),
    openCapturedAt: new Date(input.capturedAt),
    scheduledFetchAt,
    gradeScheduledAt,
    status: validStart ? "PENDING" : "NEEDS_GAME_TIME",
  };

  if (existing) {
    await prisma.openLine.deleteMany({ where: { betId: existing.id } });
    const updated = await prisma.bet.update({
      where: { id: existing.id },
      data: { ...data, openLines: { create: openLines } },
    });
    return { bet: updated, created: false };
  }

  const created = await prisma.bet.create({
    data: { ...data, openLines: { create: openLines } },
  });
  return { bet: created, created: true };
}
