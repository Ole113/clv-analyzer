import { isAuthorized, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { config, closingWindowEndsAt } from "@/lib/constants";
import type { ClosingWorkItem } from "@clv/shared";

export const dynamic = "force-dynamic";

const BATCH = 10;

/**
 * Picks currently inside their closing-read window.
 *
 * The server owns the schedule (it knows when each game starts); the extension owns the reading.
 *
 * Two things changed with the move to PropProfessor's odds screen:
 *
 *  - The window opens *before* kickoff and stays open, rather than firing once at kickoff + 2 min.
 *    A started game is no longer listed on the screen at all, so the old timing found nothing every
 *    single time. Serving a window means a failed read retries a minute later instead of burning
 *    the pick's only chance.
 *  - Served picks are leased. Without a lease the 60-second poll re-serves a DUE pick every minute
 *    while the previous read is still running, so the same pick gets read and reported repeatedly.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  const now = new Date();

  const candidates = await prisma.bet.findMany({
    where: {
      status: { in: ["PENDING", "DUE", "FETCH_FAILED"] },
      isLive: false,
      scheduledFetchAt: { not: null, lte: now },
      fetchAttempts: { lt: config.maxFetchAttempts },
      // An expired lease is simply available again, which is what makes a crashed or offline
      // browser self-healing rather than a pick stuck forever.
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
    },
    orderBy: { scheduledFetchAt: "asc" },
    // Over-fetch, because the window filter below cannot be expressed in the query: it compares
    // two columns, and SQLite via Prisma has no column-to-column comparison in `where`.
    take: BATCH * 4,
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
      sport: true,
      takenLine: true,
    },
  });

  // Past its window there is nothing left to read: the screen has dropped the game, and a line
  // fetched now would be a live or post-game number masquerading as a close.
  const due = candidates
    .filter((b) => b.gameStartTime === null || closingWindowEndsAt(b.gameStartTime) >= now)
    .slice(0, BATCH);

  if (due.length > 0) {
    await prisma.bet.updateMany({
      where: { id: { in: due.map((b) => b.id) } },
      data: {
        status: "DUE",
        leasedUntil: new Date(now.getTime() + config.closingLeaseMinutes * 60_000),
      },
    });
  }

  const work: ClosingWorkItem[] = due.map((b) => ({
    id: b.id,
    site: b.site as ClosingWorkItem["site"],
    fantasyBook: b.fantasyBook,
    marketType: b.marketType as ClosingWorkItem["marketType"],
    player: b.player,
    subjectTeam: b.subjectTeam,
    matchup: b.matchup,
    statMarket: b.statMarket,
    side: b.side as ClosingWorkItem["side"],
    externalPropId: b.externalPropId,
    pageUrl: b.pageUrl,
    gameStartTime: b.gameStartTime?.toISOString() ?? null,
    sport: b.sport,
    takenLine: b.takenLine,
  }));

  return Response.json({ ok: true, work });
}
