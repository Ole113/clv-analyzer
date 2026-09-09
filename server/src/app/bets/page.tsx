import { listBets, parseBetFilters, getFacets, boardUrlFor } from "@/lib/queries";
import { FilterBar } from "@/components/filter-bar";
import { VerdictBadge, fmtDateTime } from "@/components/ui";
import { Signed } from "@/components/value";
import { Info } from "@/components/info";

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
  const [bets, facets] = await Promise.all([listBets(parseBetFilters(params)), getFacets()]);
  const q = params.get("q");
  const settled = bets.filter((b) => b.status === "CLOSED").length;
  const waiting = bets.filter((b) => ["PENDING", "DUE", "NEEDS_GAME_TIME"].includes(b.status)).length;

  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Picks</h2>
        <FilterBar facets={facets} values={values} action="/bets" showVerdict showStatus />

      <p className="result-count">
        {bets.length} pick{bets.length === 1 ? "" : "s"}
        {q ? ` matching “${q}”` : ""} · {waiting} awaiting close · {settled} settled
      </p>

      {bets.length === 0 ? (
        <p className="muted">Nothing matches these filters.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Stat</th>
              <th>Pick</th>
              <th className="num">Taken</th>
              <th className="num">
                Avg close
                <Info title="Average closing line" anchor="consensus">
                  The mean closing line across the real sportsbooks still quoting this prop.
                  Pick&apos;em apps and derived columns are excluded. The count in brackets is how
                  many books went into it.
                </Info>
              </th>
              <th className="num">
                Edge
                <Info title="CLV edge" anchor="clv">
                  How far the line moved in your favour, in line units. Over: closing minus taken.
                  Under: taken minus closing. Positive means you beat the close.
                </Info>
              </th>
              <th className="num">
                EV%
                <Info title="Expected value" anchor="ev">
                  <code>fair probability × decimal payout − 1</code>, using the site&apos;s own
                  no-vig probability at your line.
                </Info>
              </th>
              <th>Kickoff</th>
              <th>Board</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {bets.map((b) => (
              <tr key={b.id}>
                <td>
                  <a href={`/bets/${b.id}`}>{b.player}</a>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {b.matchup ?? b.sport ?? ""}
                  </div>
                </td>
                <td>{b.statMarket}</td>
                <td>{b.side}</td>
                <td className="num">{b.takenLine}</td>
                <td className="num">
                  {b.avgClosingLine === null ? (
                    <span className="muted">--</span>
                  ) : (
                    <>
                      {b.avgClosingLine.toFixed(2)}
                      {b.closingBookCount ? (
                        <span className="muted" style={{ fontSize: 11 }}> ({b.closingBookCount})</span>
                      ) : null}
                    </>
                  )}
                </td>
                <td className="num">
                  <Signed value={b.edge} />
                </td>
                <td className="num">
                  <Signed value={b.closeEvPercent ?? b.openEvPercent} unit="%" />
                </td>
                <td>{fmtDateTime(b.gameStartTime)}</td>
                <td>
                  <a
                    className="ext"
                    href={boardUrlFor(b)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open this board on ${b.site === "ODDSJAM" ? "OddsJam" : "PropProfessor"}`}
                  >
                    {b.site === "ODDSJAM" ? "OddsJam" : "PropProf"} ↗
                  </a>
                </td>
                <td>
                  <VerdictBadge beatClv={b.beatClv} status={b.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
