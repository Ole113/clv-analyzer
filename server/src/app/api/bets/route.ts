import { isAuthorized, unauthorized } from "@/lib/auth";
import { listBets, parseBetFilters } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized();
  const filters = parseBetFilters(new URL(request.url).searchParams);
  const bets = await listBets(filters);
  return Response.json({ ok: true, count: bets.length, bets });
}
