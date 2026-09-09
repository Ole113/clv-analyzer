import { isAuthorized, unauthorized } from "@/lib/auth";
import { ingestSnapshot, snapshotSchema } from "@/lib/ingest";

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
    return Response.json(
      { error: "invalid payload", issues: parsed.error.issues.slice(0, 8) },
      { status: 422 }
    );
  }

  try {
    const { bet, created } = await ingestSnapshot(parsed.data);
    return Response.json(
      { ok: true, created, id: bet.id, status: bet.status, scheduledFetchAt: bet.scheduledFetchAt },
      { status: created ? 201 : 200 }
    );
  } catch (error) {
    console.error("[snapshots] ingest failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "ingest failed" },
      { status: 500 }
    );
  }
}
