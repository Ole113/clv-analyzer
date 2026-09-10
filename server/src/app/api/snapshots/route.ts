import { isAuthorized, unauthorized } from "@/lib/auth";
import { ingestSnapshot, snapshotSchema, validateShape } from "@/lib/ingest";
import { logIngestFailure } from "@/lib/ingest-log";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = snapshotSchema.safeParse(body);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    // The body may not even have the shape to read site/sport off of -- best effort only.
    const guess = (body ?? {}) as Record<string, unknown>;
    const row = (guess.row ?? {}) as Record<string, unknown>;
    await logIngestFailure({
      stage: "validation",
      reason,
      site: typeof guess.site === "string" ? guess.site : null,
      fantasyBook: typeof guess.fantasyBook === "string" ? guess.fantasyBook : null,
      sport: typeof row.sport === "string" ? row.sport : null,
      player: typeof row.player === "string" ? row.player : null,
      statMarket: typeof row.statMarket === "string" ? row.statMarket : null,
      payload: body,
    });
    return Response.json(
      { error: "invalid payload", issues: parsed.error.issues.slice(0, 8) },
      { status: 422 }
    );
  }

  // Shape rules the flat schema cannot express. Returned as a sentence rather than a Zod dump so
  // the board can tell the user what is actually wrong with the row they ticked.
  const shapeError = validateShape(parsed.data.row);
  if (shapeError) {
    await logIngestFailure({
      stage: "shape",
      reason: shapeError,
      site: parsed.data.site,
      fantasyBook: parsed.data.fantasyBook,
      sport: parsed.data.row.sport,
      player: parsed.data.row.player,
      statMarket: parsed.data.row.statMarket,
      payload: parsed.data,
    });
    return Response.json({ error: shapeError }, { status: 422 });
  }

  try {
    const { bet, created } = await ingestSnapshot(parsed.data);
    return Response.json(
      { ok: true, created, id: bet.id, status: bet.status, scheduledFetchAt: bet.scheduledFetchAt },
      { status: created ? 201 : 200 }
    );
  } catch (error) {
    console.error("[snapshots] ingest failed:", error);
    await logIngestFailure({
      stage: "exception",
      reason: error instanceof Error ? error.message : "ingest failed",
      site: parsed.data.site,
      fantasyBook: parsed.data.fantasyBook,
      sport: parsed.data.row.sport,
      player: parsed.data.row.player,
      statMarket: parsed.data.row.statMarket,
      payload: parsed.data,
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });
    return Response.json(
      { error: error instanceof Error ? error.message : "ingest failed" },
      { status: 500 }
    );
  }
}
