import { z } from "zod";

/**
 * Validates a `ClosingReadOutcome` (shared/src/types.ts) posted by the extension. Shared between
 * `/api/closing-snapshots` (the real, permanent closing read) and `/api/odds-preview-work` (an
 * on-demand, throwaway "what does it say right now" read) -- both receive the exact same shape
 * from the exact same reader (`readClosingLines`), so one schema keeps them from drifting apart.
 */

const bookLineSchema = z.object({
  bookKey: z.string().min(1),
  label: z.string().nullable(),
  line: z.number().nullable(),
  price: z.number().nullable(),
  logoUrl: z.string().nullable().optional().default(null),
  liquidity: z.number().nullable().optional().default(null),
  fairProbability: z.number().nullable().optional().default(null),
  rawText: z.string(),
});

const rowSchema = z.object({
  rowIndex: z.number(),
  marketType: z
    .enum(["PLAYER_PROP", "GAME_TOTAL", "SPREAD", "MONEYLINE", "OTHER"])
    .optional()
    .default("PLAYER_PROP"),
  player: z.string().nullable(),
  selectionName: z.string().nullable().optional().default(null),
  subjectTeam: z.string().nullable().optional().default(null),
  isLive: z.boolean().optional().default(false),
  team: z.string().nullable(),
  opponent: z.string().nullable(),
  matchup: z.string().nullable(),
  sport: z.string().nullable(),
  statMarket: z.string().nullable(),
  side: z.enum(["OVER", "UNDER"]).nullable(),
  takenLine: z.number().nullable(),
  fairProbability: z.number().nullable().optional().default(null),
  boardEvPercent: z.number().nullable().optional().default(null),
  gameStartTimeText: z.string().nullable(),
  gameStartTimeIso: z.string().nullable(),
  externalPropId: z.string().nullable(),
  externalPlayerId: z.string().nullable(),
  bookLines: z.array(bookLineSchema),
  rawText: z.string(),
});

const sourceSchema = z.object({
  site: z.literal("PROPPROFESSOR_SCREEN"),
  url: z.string(),
  league: z.string(),
  market: z.string(),
});

export const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MATCHED"), row: rowSchema, source: sourceSchema }),
  z.object({
    kind: z.literal("SELECTION_ABSENT"),
    source: sourceSchema,
    candidateCount: z.number(),
    sampleNames: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal("MARKET_NOT_OFFERED"),
    source: sourceSchema,
    availableMarkets: z.array(z.string()).default([]),
  }),
  z.object({ kind: z.literal("NO_CLOSING_MARKET"), reason: z.string() }),
  z.object({ kind: z.literal("READ_FAILED"), reason: z.string() }),
]);
