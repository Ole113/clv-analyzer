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
  logoUrl: z.string().nullable().optional().default(null),
  rawText: z.string(),
});

const rowSchema = z.object({
  rowIndex: z.number(),
  marketType: z
    .enum(["PLAYER_PROP", "GAME_TOTAL", "SPREAD", "OTHER"])
    .optional()
    .default("PLAYER_PROP"),
  // Null on game markets, which have no player. A player prop with no player is rejected below.
  player: z.string().min(1).nullable().optional().default(null),
  selectionName: z.string().nullable().optional().default(null),
  subjectTeam: z.string().nullable().optional().default(null),
  isLive: z.boolean().optional().default(false),
  team: z.string().nullable(),
  opponent: z.string().nullable(),
  matchup: z.string().nullable(),
  sport: z.string().nullable(),
  statMarket: z.string().min(1),
  // Null on spreads, where the signed line carries the direction.
  side: z.enum(["OVER", "UNDER"]).nullable().optional().default(null),
  takenLine: z.number(),
  fairProbability: z.number().nullable().optional().default(null),
  boardEvPercent: z.number().nullable().optional().default(null),
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

/**
 * Shape rules the flat schema cannot express: a player prop must name a player and a side, and a
 * spread must name the team its signed line belongs to. Returning the reason (rather than a bare
 * 400) is what lets the board show the user why a tick did not stick.
 */
export function validateShape(row: SnapshotInput["row"]): string | null {
  if (row.marketType === "PLAYER_PROP") {
    if (!row.player) return "This row has no player name, so it cannot be tracked as a player prop.";
    if (!row.side) return "This row has no Over/Under side.";
  }
  if (row.marketType === "GAME_TOTAL" && !row.side) {
    return "This total has no Over/Under side.";
  }
  if (row.marketType === "SPREAD" && !row.subjectTeam) {
    return "This spread does not say which team the line belongs to.";
  }
  if (row.marketType === "OTHER") {
    return "This market has no line to measure closing line value against (moneylines and exotics are not trackable).";
  }
  return null;
}

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
    marketType: row.marketType,
    player: row.player,
    subjectTeam: row.subjectTeam,
    statMarket: row.statMarket,
    side: row.side,
    gameStartTime: validStart,
  });

  // Re-checking the same row should update the pick rather than double-count it in the stats.
  const existing = await prisma.bet.findFirst({
    where: { matchKey, status: { in: ["PENDING", "NEEDS_GAME_TIME", "DUE", "LIVE_NO_CLV"] } },
  });

  const openLines = row.bookLines.map((b) => ({
    bookKey: b.bookKey,
    label: b.label,
    line: b.line,
    price: b.price,
    logoUrl: b.logoUrl,
    rawText: b.rawText,
    includedInAverage: isSportsbookForAverage(b.bookKey, b.label, typeof b.line === "number"),
  }));

  // A live pick gets no closing read: the line was taken mid-game, so there is no "close" to
  // compare it against. It is still captured, graded and shown -- just never given a CLV verdict.
  const status = row.isLive
    ? "LIVE_NO_CLV"
    : validStart
      ? "PENDING"
      : "NEEDS_GAME_TIME";

  const data = {
    site: input.site,
    fantasyBook: input.fantasyBook.toLowerCase(),
    sport: row.sport,
    marketType: row.marketType,
    player: row.player,
    selectionName: row.selectionName,
    subjectTeam: row.subjectTeam,
    isLive: row.isLive,
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
    // Boards that publish an EV% directly (OddsJam rebet/fliff) are recorded as stated; the rest
    // derive it from the fair probability and the pick'em payout.
    openEvPercent:
      row.boardEvPercent ?? evPercent(row.fairProbability, fantasyPriceFrom(row.bookLines)),
    openRawSnapshotJson: JSON.stringify(row),
    openCapturedAt: new Date(input.capturedAt),
    // A live pick is never scheduled for a closing read.
    scheduledFetchAt: row.isLive ? null : scheduledFetchAt,
    gradeScheduledAt,
    status,
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
