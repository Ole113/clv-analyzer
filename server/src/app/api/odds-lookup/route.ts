import { z } from "zod";
import type { ClosingWorkItem } from "@clv/shared";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { lookupOddsNow } from "@/lib/odds-preview";

export const dynamic = "force-dynamic";

/**
 * "What is this market priced at right now" for a row that is not a tracked pick.
 *
 * The Odds modal on `/bets` works from a bet id, because there is a bet. This is the same read for
 * a row the user is still looking at on a board -- the odds button the extension injects next to
 * each checkbox -- where nothing has been ticked and may never be.
 *
 * It is a route rather than more logic in the extension on purpose. The averaging, the sportsbook
 * allowlist and the outlier test all live in `buildClosingVerdict`, and a second implementation in
 * the content script would drift from it silently: the board modal and the dashboard modal would
 * start disagreeing about what the closing number is, which is worse than not having the board
 * modal at all.
 *
 * Reads PropProfessor, never the board the request came from. An OddsJam row asks this the same way
 * a PropProfessor row does, and gets an answer from the same place -- the capture site is provenance
 * and has no influence on where the read goes. See `oddsjam-automation-guard.test.ts`.
 */

const lookupSchema = z.object({
  sport: z.string().nullable().optional().default(null),
  statMarket: z.string().min(1),
  marketType: z
    .enum(["PLAYER_PROP", "GAME_TOTAL", "SPREAD", "MONEYLINE", "OTHER"])
    .optional()
    .default("PLAYER_PROP"),
  player: z.string().nullable().optional().default(null),
  subjectTeam: z.string().nullable().optional().default(null),
  matchup: z.string().nullable().optional().default(null),
  side: z.enum(["OVER", "UNDER"]).nullable().optional().default(null),
  takenLine: z.number().nullable().optional().default(null),
  externalPropId: z.string().nullable().optional().default(null),
  /** Set by the modal's Refresh button, so a deliberate re-check is never served from the cache. */
  refresh: z.boolean().optional().default(false),
});

export async function POST(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = lookupSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", issues: parsed.error.issues.slice(0, 8) },
      { status: 422 }
    );
  }

  const { refresh, ...identity } = parsed.data;
  // The fields a screen read does not consult are filled with the empty values `ClosingWorkItem`
  // expects rather than being made optional on the type: `planScreenRead` reads only sport, market
  // and market type, and `findMatchingRow` only the identity fields above.
  const item: ClosingWorkItem = {
    id: "lookup",
    site: "PROPPROFESSOR",
    fantasyBook: "",
    pageUrl: null,
    gameStartTime: null,
    ...identity,
  };

  const preview = await lookupOddsNow(item, { allowCache: !refresh });
  return Response.json({ ok: true, preview });
}
