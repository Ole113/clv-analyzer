import { isAuthorized, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getBetDetail } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * Makes a pick due immediately instead of at kickoff + buffer, so the extension reads it on its
 * next poll. This is how you exercise the whole pipeline without waiting for a real kickoff.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(request)) return unauthorized();
  const { id } = await params;

  const existing = await prisma.bet.findUnique({ where: { id } });
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });

  await prisma.bet.update({
    where: { id },
    data: { scheduledFetchAt: new Date(), status: "PENDING", fetchAttempts: 0, lastFetchError: null },
  });

  const bet = await getBetDetail(id);
  return Response.json({ ok: true, queued: true, bet });
}
