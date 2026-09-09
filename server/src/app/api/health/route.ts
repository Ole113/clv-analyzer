import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Unauthenticated on purpose: the extension's "Test Connection" button hits this first. */
export async function GET() {
  try {
    const bets = await prisma.bet.count();
    return Response.json({ ok: true, version: "0.1.0", bets });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "db unavailable" },
      { status: 500 }
    );
  }
}
