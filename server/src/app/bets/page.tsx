import { listBets, parseBetFilters, getFacets, boardUrlFor, oddsScreenUrlFor } from "@/lib/queries";
import { listPikkitBets } from "@/lib/pikkit/queries";
import { getPikkitFacets, parsePikkitFilters } from "@/lib/pikkit/analysis";
import { FilterBar } from "@/components/filter-bar";
import { BetsTable } from "@/components/bets-table";
import { PikkitBetsTable } from "@/components/pikkit-bets-table";
import { PikkitFilterBar } from "@/components/pikkit-filter-bar";
import { SourceSwitch, sourceFrom } from "@/components/source-switch";

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
  const source = sourceFrom(params);

  // The same source switch as /analysis, so a row in a chart can be chased back to the bets behind
  // it without first having to notice that this page is showing the other dataset.
  if (source === "pikkit") {
    const [bets, facets] = await Promise.all([
      listPikkitBets(parsePikkitFilters(params)),
      getPikkitFacets(),
    ]);
    return (
      <main>
        <h2 style={{ marginTop: 0 }}>Picks</h2>
        <SourceSwitch source={source} basePath="/bets" params={params} />
        <PikkitFilterBar facets={facets} values={values} action="/bets" />
        {bets.length === 0 ? (
          <p className="muted">Nothing matches these filters.</p>
        ) : (
          <PikkitBetsTable bets={bets} />
        )}
      </main>
    );
  }

  const [rawBets, facets] = await Promise.all([listBets(parseBetFilters(params)), getFacets()]);
  // Server Components can't hand a Client Component a function prop (it isn't serializable across
  // the RSC boundary) -- these are pure functions of a bet's own fields, so computing the strings
  // here and shipping data instead is simpler than exposing them as server actions.
  const bets = rawBets.map((b) => ({ ...b, boardUrl: boardUrlFor(b), oddsScreenUrl: oddsScreenUrlFor(b) }));

  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Picks</h2>
      <SourceSwitch source={source} basePath="/bets" params={params} />
      <FilterBar facets={facets} values={values} action="/bets" showVerdict showStatus showResult />

      {bets.length === 0 ? (
        <p className="muted">Nothing matches these filters.</p>
      ) : (
        <BetsTable bets={bets} />
      )}
    </main>
  );
}
