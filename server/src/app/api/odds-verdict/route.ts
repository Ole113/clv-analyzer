import { z } from "zod";
import type { ClosingWorkItem, OddsTerminalFixture, OddsTerminalOddsEntry } from "@clv/shared";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { lookupFromRelay } from "@/lib/odds-preview";
import { planRelayRead } from "@/lib/odds-terminal-verdict";

export const dynamic = "force-dynamic";

/**
 * Plans an Odds Terminal read, and turns the entries it produced into a verdict.
 *
 * ## Why this route exists at all
 *
 * The averaging, the sportsbook allowlist and the outlier test live in `buildClosingVerdict`, and
 * a second implementation inside the extension would drift from it silently -- the board modal and
 * the dashboard modal would begin quoting different closing numbers for the same market with no way
 * to tell which was right. That is the same reasoning `/api/odds-lookup` is built on, and it does
 * not stop applying just because a different party did the fetching.
 *
 * ## Why the *extension* did the fetching
 *
 * Odds Terminal is account-gated and sits behind a session cookie in the user's own browser. The
 * arrangement that got the PropProfessor account banned (2026-09) was a captured credential driving
 * server-initiated reads on a timer, firing whether or not anyone was looking. So this server never
 * contacts Odds Terminal: the read happens in the extension's background worker, in response to a
 * click, on the session the browser already has, and the entries arrive here as a request body.
 *
 * What that buys, concretely: there is no scheduled path to this route, no stored session, and
 * nothing here that could reach Odds Terminal even if someone later added a cron job -- the only
 * input is a payload. `oddsjam-automation-guard.test.ts` asserts the host appears nowhere in server
 * code.
 *
 * ## Two phases
 *
 *   1. `{plan:true}` -> what to ask for: the sport and league ids, the market names that count as
 *      an answer, and which books to request, ranked by the user's own book order (a database
 *      setting the extension has no business knowing).
 *   2. `{read}`      -> the verdict, from the fixture the worker matched and the entries it kept.
 *
 * It used to be three, with a middle hop that resolved the fixture from a snapshot. That hop is
 * gone: the worker resolves it with the same shared matcher, which saves a round trip to a tailnet
 * host on every click and lets it walk a paginated slate without asking permission page by page.
 */

const identitySchema = {
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
  /** The board's own kickoff for this row, when it rendered one. Narrows the slate request. */
  gameStartIso: z.string().nullable().optional().default(null),
};

/** "What should the extension ask Odds Terminal for?" -- nothing has been read yet. */
const planRequestSchema = z.object({ ...identitySchema, plan: z.literal(true) });

/**
 * "Here is what Odds Terminal said."
 *
 * `fixture` and the entries are `z.unknown()` rather than modelled shapes on purpose: they are a
 * third party's response, they will change without notice, and the parsers are already written to
 * treat every field as untrusted and to return a reason rather than throw. Validating twice, in two
 * places that could disagree, would buy nothing.
 */
const readRequestSchema = z.object({
  ...identitySchema,
  read: z.object({
    fixture: z.unknown(),
    entries: z.array(z.unknown()).default([]),
    marketsSeen: z.array(z.string()).optional(),
  }),
});

function workItem(
  identity: Omit<z.infer<typeof planRequestSchema>, "plan">
): ClosingWorkItem & { gameStartIso: string | null } {
  // The fields a lookup does not consult are filled with the empty values `ClosingWorkItem`
  // expects rather than being made optional on the type -- exactly as `/api/odds-lookup` does.
  return {
    id: "lookup",
    site: "ODDSJAM",
    fantasyBook: "",
    pageUrl: null,
    gameStartTime: null,
    ...identity,
  };
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const asPlan = planRequestSchema.safeParse(body);
  if (asPlan.success) {
    const { plan: _plan, ...identity } = asPlan.data;
    const planned = await planRelayRead(workItem(identity));
    if ("kind" in planned) {
      // Not an error status: "Odds Terminal does not cover college hockey" is a real, final answer
      // to the question asked, and the modal shows it as one.
      return Response.json({ ok: false, reason: planned.reason, kind: planned.kind });
    }
    return Response.json({ ok: true, plan: planned });
  }

  const parsed = readRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", issues: parsed.error.issues.slice(0, 8) },
      { status: 422 }
    );
  }

  const { read, ...identity } = parsed.data;
  const preview = await lookupFromRelay(workItem(identity), {
    fixture: read.fixture as OddsTerminalFixture,
    entries: read.entries as OddsTerminalOddsEntry[],
    marketsSeen: read.marketsSeen,
  });
  return Response.json({ ok: true, preview });
}
