import { listBets, parseBetFilters, getFacets, boardUrlFor, oddsScreenUrlFor } from "@/lib/queries";
import { FilterBar } from "@/components/filter-bar";
import { BetsTable } from "@/components/bets-table";

export const dynamic = "force-dynamic";

export default async function BetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v) params.set(k, v);

  const values = Object.fromEntries(params.entries());
  const [rawBets, facets] = await Promise.all([listBets(parseBetFilters(params)), getFacets()]);
  // Server Components can't hand a Client Component a function prop (it isn't serializable across
  // the RSC boundary) -- these are pure functions of a bet's own fields, so computing the strings
  // here and shipping data instead is simpler than exposing them as server actions.
  const bets = rawBets.map((b) => ({ ...b, boardUrl: boardUrlFor(b), oddsScreenUrl: oddsScreenUrlFor(b) }));
  const q = params.get("q");
  const settled = bets.filter((b) => b.status === "CLOSED").length;
  const graded = bets.filter((b) => b.gradeResult === "WIN" || b.gradeResult === "LOSS").length;
  const waiting = bets.filter((b) => ["PENDING", "DUE", "NEEDS_GAME_TIME"].includes(b.status)).length;

  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Picks</h2>
        <FilterBar facets={facets} values={values} action="/bets" showVerdict showStatus showResult />

      <p className="result-count">
        {bets.length} pick{bets.length === 1 ? "" : "s"}
        {q ? ` matching “${q}”` : ""} · {waiting} awaiting close · {settled} settled ·{" "}
        {graded} graded
      </p>

      {bets.length === 0 ? (
        <p className="muted">Nothing matches these filters.</p>
      ) : (
        <BetsTable bets={bets} />
      )}
    </main>
  );
}
