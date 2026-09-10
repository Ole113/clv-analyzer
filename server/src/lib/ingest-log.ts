import { prisma } from "./prisma";

/** Keeps a bad payload readable without letting one enormous row bloat the table. */
const MAX_PAYLOAD_CHARS = 20_000;

export interface IngestFailureInput {
  stage: "validation" | "shape" | "exception";
  reason: string;
  site?: string | null;
  fantasyBook?: string | null;
  sport?: string | null;
  player?: string | null;
  statMarket?: string | null;
  /** Whatever was available at the point of failure -- the raw body, or just the parsed row. */
  payload?: unknown;
  stack?: string | null;
}

/**
 * Records a pick the extension tried to send but could not be tracked, so "why didn't this show
 * up" has an answer in Settings instead of only a server log nobody is tailing.
 *
 * Deliberately swallows its own errors: a broken debug log must never be the reason a request that
 * was already failing fails a second, more confusing way.
 */
export async function logIngestFailure(input: IngestFailureInput): Promise<void> {
  try {
    await prisma.ingestFailure.create({
      data: {
        stage: input.stage,
        reason: input.reason,
        site: input.site ?? null,
        fantasyBook: input.fantasyBook ?? null,
        sport: input.sport ?? null,
        player: input.player ?? null,
        statMarket: input.statMarket ?? null,
        payloadJson:
          input.payload === undefined ? null : JSON.stringify(input.payload).slice(0, MAX_PAYLOAD_CHARS),
        stack: input.stack ?? null,
      },
    });
  } catch (error) {
    console.error("[ingest-log] failed to record ingest failure:", error);
  }
}

export async function getRecentIngestFailures(limit = 25) {
  return prisma.ingestFailure.findMany({
    orderBy: { occurredAt: "desc" },
    take: limit,
  });
}

export async function countIngestFailures(): Promise<number> {
  return prisma.ingestFailure.count();
}

export async function clearIngestFailures(): Promise<number> {
  const { count } = await prisma.ingestFailure.deleteMany({});
  return count;
}
