import { z } from "zod";
import { oddsTerminalSnapshotPath, type ClosingWorkItem } from "@clv/shared";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { lookupFromRelay } from "@/lib/odds-preview";
import { planRelayRead } from "@/lib/odds-terminal-verdict";

export const dynamic = "force-dynamic";

/**
 * Turns an Odds Terminal snapshot the extension already fetched into a verdict.
 *
 * ## Why this route exists at all
 *
 * The averaging, the sportsbook allowlist and the outlier test live in `buildClosingVerdict`, and
 * a second implementation inside a content script would drift from it silently -- the board modal
 * and the dashboard modal would begin quoting different closing numbers for the same market with
 * no way to tell which was right. That is the same reasoning `/api/odds-lookup` is built on, and
 * it does not stop applying just because a different party did the fetching.
 *
 * ## Why the *extension* did the fetching
 *
 * Odds Terminal is account-gated and sits behind a session cookie in the user's own browser. The
 * arrangement that got the PropProfessor account banned (2026-09) was a captured credential driving
 * server-initiated reads on a timer, firing whether or not anyone was looking. So this server never
 * contacts Odds Terminal: the read happens in a tab the user's own click opened, by a content
 * script that cannot run without a message, and the bytes arrive here as a request body.
 *
 * What that buys, concretely: there is no scheduled path to this route, no stored session, and
 * nothing here that could reach Odds Terminal even if someone later added a cron job -- the only
 * input is a payload. `oddsjam-automation-guard.test.ts` asserts the host appears nowhere in
 * server or background code.
 *
 * ## Two requests, not one
 *
 * A GET-shaped `?plan=1` POST answers "what should I ask for", because the book ordering the query
 * depends on is a user setting living in the database, and the content script has no business
 * knowing this project's market vocabulary. The relay then fetches, and POSTs the body back here
 * for the verdict. Splitting it keeps every piece of vocabulary server-side.
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
};

/** "What should the relay ask Odds Terminal for?" -- no snapshot yet. */
const planRequestSchema = z.object({ ...identitySchema, plan: z.literal(true) });

/**
 * "Here is what Odds Terminal said."
 *
 * `snapshot` is `z.unknown()` rather than a modelled shape on purpose: it is a third party's
 * response body, it will change without notice, and `normalizeOddsTerminalSnapshot` is already
 * written to treat every field as untrusted and to return a reason rather than throw. Validating
 * it twice, in two places that could disagree, would buy nothing.
 */
const verdictRequestSchema = z.object({ ...identitySchema, snapshot: z.unknown() });

function workItem(identity: Omit<z.infer<typeof planRequestSchema>, "plan">): ClosingWorkItem {
  // The fields a snapshot read does not consult are filled with the empty values `ClosingWorkItem`
  // expects rather than being made optional on the type -- exactly as `/api/odds-lookup` does.
  return {
    id: "lookup",
    site: "PROPPROFESSOR",
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
      // Not an error status: "Odds Terminal does not carry 1st-half college hockey" is a real,
      // final answer to the question asked, and the modal shows it as one.
      return Response.json({ ok: false, reason: planned.reason, kind: planned.kind });
    }
    // The finished path goes back, not just the plan: the relay appends nothing of its own, which
    // is what keeps this project's market and book vocabulary entirely server-side. It is relative
    // by construction (`oddsTerminalSnapshotPath` cannot produce a host), so the content script can
    // only ever fetch it against the origin it is already running on.
    return Response.json({ ok: true, plan: planned, path: oddsTerminalSnapshotPath(planned) });
  }

  const parsed = verdictRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", issues: parsed.error.issues.slice(0, 8) },
      { status: 422 }
    );
  }

  const { snapshot, ...identity } = parsed.data;
  const preview = await lookupFromRelay(workItem(identity), { body: snapshot });
  return Response.json({ ok: true, preview });
}
