import { z } from "zod";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OPEN_STATUSES } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * Which of the rows currently on a board are already being tracked.
 *
 * The board asks by match key -- the same key the server stored -- so a ticked checkbox survives
 * a refresh, a re-sort, and the line moving underneath it. Only picks that are still open count:
 * once a pick has closed there is nothing left to untick.
 */
const lookupSchema = z.object({
  matchKeys: z.array(z.string().min(1)).max(500),
});

const removeSchema = z.object({
  matchKey: z.string().min(1),
});

/** Statuses a pick can be in while its board row is still on screen and still untickable. */
const TRACKABLE = [...OPEN_STATUSES, "LIVE_NO_CLV"];

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
    return Response.json({ error: "invalid payload" }, { status: 422 });
  }
  if (parsed.data.matchKeys.length === 0) return Response.json({ ok: true, tracked: [] });

  const bets = await prisma.bet.findMany({
    where: { matchKey: { in: parsed.data.matchKeys }, status: { in: TRACKABLE } },
    select: { id: true, matchKey: true, status: true },
  });

  return Response.json({ ok: true, tracked: bets });
}

/**
 * Removes a pick that the user has just unticked on the board.
 *
 * Scoped to open picks on purpose: unticking a row should never delete a pick whose closing line
 * has already been recorded, because that is real measured history rather than a mis-click.
 */
export async function DELETE(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = removeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid payload" }, { status: 422 });
  }

  const { count } = await prisma.bet.deleteMany({
    where: { matchKey: parsed.data.matchKey, status: { in: TRACKABLE } },
  });

  if (count === 0) {
    return Response.json(
      {
        ok: false,
        error:
          "That pick is no longer open — its closing line has already been recorded, so it was kept.",
      },
      { status: 409 }
    );
  }

  return Response.json({ ok: true, removed: count });
}
