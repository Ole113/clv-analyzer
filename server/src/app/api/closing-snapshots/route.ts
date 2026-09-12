import { z } from "zod";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { applyClosingReport } from "@/lib/apply-closing";
import { outcomeSchema } from "@/lib/closing-outcome-schema";

export const dynamic = "force-dynamic";

// row/bookLine shapes for the legacy (pre-`outcome`) fields below only -- the current shape's
// validation lives in `outcomeSchema`, shared with `/api/odds-preview-work`.
const bookLineSchema = z.object({
  bookKey: z.string().min(1),
  label: z.string().nullable(),
  line: z.number().nullable(),
  price: z.number().nullable(),
  logoUrl: z.string().nullable().optional().default(null),
  // Optional so an extension built before liquidity was captured still posts a valid report --
  // the whole point of the legacy tolerance further down this file.
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

/**
 * The legacy fields stay optional for one release so an extension that has not been reloaded yet
 * keeps reporting instead of 422ing every minute -- the extension has to be reloaded by hand in
 * each browser, so the two versions genuinely do overlap in the wild.
 */
const reportSchema = z
  .object({
    betId: z.string().min(1),
    outcome: outcomeSchema.optional(),
    row: rowSchema.nullable().optional(),
    parseOk: z.boolean().optional(),
    boardRowCount: z.number().optional(),
    reason: z.string().nullable().optional(),
  })
  .refine((r) => r.outcome !== undefined || r.parseOk !== undefined, {
    message: "expected either an outcome or the legacy parseOk/row fields",
  });

/** Receives a closing board read performed by the extension in the user's own browser. */
export async function POST(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", issues: parsed.error.issues.slice(0, 8) },
      { status: 422 }
    );
  }

  const result = await applyClosingReport(parsed.data);
  if (!result.ok) return Response.json({ error: result.error }, { status: 404 });
  return Response.json(result);
}
