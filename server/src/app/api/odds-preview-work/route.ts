import { z } from "zod";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { outcomeSchema } from "@/lib/closing-outcome-schema";
import { takePendingPreviews, recordPreviewResult } from "@/lib/odds-preview";

export const dynamic = "force-dynamic";

/**
 * The on-demand counterpart to `/api/closing-work` + `/api/closing-snapshots`: instead of the
 * server deciding what's due by kickoff, the Odds modal enqueues a request the moment someone
 * opens it, and this is what the extension's next poll (same 60-second alarm, since
 * `chrome.alarms` can't fire faster) picks up and answers.
 *
 * No lease here, unlike `/api/closing-work`: that queue can hold hundreds of picks that must not
 * be double-served while a slow read is in flight, but this one is realistically ever a couple of
 * ad hoc, human-triggered requests at a time. `takePendingPreviews()` simply drains the queue on
 * every poll -- worst case a request is served on the next poll instead of this one, which the
 * modal already tolerates by design (its own "checking your browser..." wait, and a Refresh button
 * to ask again).
 */

const reportSchema = z.object({
  betId: z.string().min(1),
  outcome: outcomeSchema,
});

export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized();
  return Response.json({ ok: true, work: takePendingPreviews() });
}

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

  await recordPreviewResult(parsed.data.betId, parsed.data.outcome);
  return Response.json({ ok: true });
}
