import { isAuthorized, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getBetDetail } from "@/lib/queries";
import { config } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(request)) return unauthorized();
  const { id } = await params;
  const bet = await getBetDetail(id);
  if (!bet) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true, bet });
}

/**
 * Sets a kickoff time for a pick captured without one (PropProfessor's default column set can
 * omit it), scheduling the closing fetch that could not be scheduled at capture time.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(request)) return unauthorized();
  const { id } = await params;

  let body: { gameStartTime?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.gameStartTime) return Response.json({ error: "gameStartTime required" }, { status: 400 });
  const start = new Date(body.gameStartTime);
  if (Number.isNaN(start.getTime())) {
    return Response.json({ error: "invalid gameStartTime" }, { status: 400 });
  }

  const bet = await prisma.bet.update({
    where: { id },
    data: {
      gameStartTime: start,
      scheduledFetchAt: new Date(start.getTime() + config.closingBufferMinutes * 60_000),
      status: "PENDING",
      fetchAttempts: 0,
      lastFetchError: null,
    },
  });

  return Response.json({
    ok: true,
    bet: { id: bet.id, status: bet.status, scheduledFetchAt: bet.scheduledFetchAt },
  });
}
