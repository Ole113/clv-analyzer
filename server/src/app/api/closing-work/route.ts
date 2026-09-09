import { isAuthorized, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { config } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * Picks whose kickoff + buffer has passed and that still need a closing read.
 *
 * The server owns the schedule (it knows a 5:30 game is due at 5:32); the extension owns the
 * reading, because only the user's own logged-in Chrome can actually load these boards.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  const due = await prisma.bet.findMany({
    where: {
      status: { in: ["PENDING", "DUE", "FETCH_FAILED"] },
      isLive: false,
      scheduledFetchAt: { not: null, lte: new Date() },
      fetchAttempts: { lt: config.maxFetchAttempts },
    },
    orderBy: { scheduledFetchAt: "asc" },
    take: 10,
    select: {
      id: true,
      site: true,
      fantasyBook: true,
      marketType: true,
      player: true,
      subjectTeam: true,
      matchup: true,
      statMarket: true,
      side: true,
      externalPropId: true,
      pageUrl: true,
      gameStartTime: true,
    },
  });

  if (due.length > 0) {
    await prisma.bet.updateMany({
      where: { id: { in: due.map((b) => b.id) }, status: { in: ["PENDING", "FETCH_FAILED"] } },
      data: { status: "DUE" },
    });
  }

  return Response.json({ ok: true, work: due });
}
