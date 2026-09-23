import { z } from "zod";
import {
  oddsTerminalSnapshotPath,
  type ClosingWorkItem,
  type OddsTerminalFixture,
  type OddsTerminalStreamEntry,
} from "@clv/shared";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { lookupFromRelay } from "@/lib/odds-preview";
import { planRelayRead, resolveRelayedFixture } from "@/lib/odds-terminal-verdict";

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
 * ## Three phases, because the feed needs two requests
 *
 * `/api/snapshot` serves main markets only; player props come from `/api/stream`, which requires a
 * `fixture_id` and offers no way to discover one. So a lookup is:
 *
 *   1. `{plan:true}`      -> the snapshot path to fetch (book ordering is a DB setting, and the
 *                            content script has no business knowing this project's vocabulary).
 *   2. `{snapshot}`       -> the fixture resolved from it, plus the stream path to read next.
 *   3. `{stream}`         -> the verdict.
 *
 * Every path handed back is relative by construction, so the relay can only ever fetch against the
 * origin the user's own click put it on.
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
 * Bodies are `z.unknown()` rather than modelled shapes on purpose: they are a third party's
 * responses, they will change without notice, and the parsers are already written to treat every
 * field as untrusted and to return a reason rather than throw. Validating twice, in two places
 * that could disagree, would buy nothing.
 */
const snapshotRequestSchema = z.object({ ...identitySchema, snapshot: z.unknown() });

/** "Here is what the stream said." */
const streamRequestSchema = z.object({
  ...identitySchema,
  stream: z.object({ entries: z.array(z.unknown()).optional(), fixture: z.unknown() }),
});

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

  const asSnapshot = snapshotRequestSchema.safeParse(body);
  if (asSnapshot.success) {
    const { snapshot, ...identity } = asSnapshot.data;
    const item = workItem(identity);
    const planned = await planRelayRead(item);
    if ("kind" in planned) {
      return Response.json({ ok: false, reason: planned.reason, kind: planned.kind });
    }
    const resolved = resolveRelayedFixture(item, planned, { body: snapshot });
    if ("kind" in resolved) {
      // A read outcome rather than a fixture: the game is not on this slate, or the snapshot was
      // unreadable. Final, and shown as such.
      return Response.json({
        ok: false,
        reason: "reason" in resolved ? resolved.reason : "Odds Terminal could not be read.",
      });
    }
    return Response.json({
      ok: true,
      streamPath: resolved.streamPath,
      fixture: resolved.fixture,
    });
  }

  const parsed = streamRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", issues: parsed.error.issues.slice(0, 8) },
      { status: 422 }
    );
  }

  const { stream, ...identity } = parsed.data;
  const preview = await lookupFromRelay(workItem(identity), {
    entries: (stream.entries ?? []) as OddsTerminalStreamEntry[],
    fixture: stream.fixture as OddsTerminalFixture,
  });
  return Response.json({ ok: true, preview });
}
