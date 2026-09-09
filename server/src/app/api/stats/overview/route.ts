import { isAuthorized, unauthorized } from "@/lib/auth";
import { getOverviewStats, parseBetFilters } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized();
  const filters = parseBetFilters(new URL(request.url).searchParams);
  const stats = await getOverviewStats(filters);
  return Response.json({ ok: true, ...stats });
}
