import { z } from "zod";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { applyClosingReport } from "@/lib/apply-closing";

export const dynamic = "force-dynamic";

const bookLineSchema = z.object({
  bookKey: z.string().min(1),
  label: z.string().nullable(),
  line: z.number().nullable(),
  price: z.number().nullable(),
  rawText: z.string(),
});

const rowSchema = z.object({
  rowIndex: z.number(),
  player: z.string().nullable(),
  team: z.string().nullable(),
  opponent: z.string().nullable(),
  matchup: z.string().nullable(),
  sport: z.string().nullable(),
  statMarket: z.string().nullable(),
  side: z.enum(["OVER", "UNDER"]).nullable(),
  takenLine: z.number().nullable(),
  fairProbability: z.number().nullable().optional().default(null),
  gameStartTimeText: z.string().nullable(),
  gameStartTimeIso: z.string().nullable(),
  externalPropId: z.string().nullable(),
  externalPlayerId: z.string().nullable(),
  bookLines: z.array(bookLineSchema),
  rawText: z.string(),
});

const reportSchema = z.object({
  betId: z.string().min(1),
  row: rowSchema.nullable(),
  parseOk: z.boolean(),
  boardRowCount: z.number(),
  reason: z.string().nullable().optional(),
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
