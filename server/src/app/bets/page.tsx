import { listBets, parseBetFilters, getFacets, boardUrlFor, oddsScreenUrlFor } from "@/lib/queries";
import { FilterBar } from "@/components/filter-bar";
import { VerdictBadge, ResultBadge, fmtDateTime, fmtOdds, sideLabel, betTitle } from "@/components/ui";
import { BetRow } from "@/components/bet-row";
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
        <table>
          <thead>
            <tr>
              <th>Pick</th>
              <th>Market</th>
              <th>Side</th>
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
              <th className="num">
                Actual
                <Info title="Actual result" anchor="grading">
                  What the player actually recorded, read from the official box score after the
                  game finished, shown against the line you took.
                </Info>
              </th>
              <th>Kickoff</th>
              <th>Board</th>
              <th>CLV</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {bets.map((b) => (
              <BetRow key={b.id} id={b.id} label={betTitle(b)}>
                <td>
                  <a href={`/bets/${b.id}`}>{b.player ?? b.selectionName ?? b.statMarket}</a>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {b.matchup ?? b.sport ?? ""}
                    {b.isLive && <span className="live-chip">LIVE</span>}
                  </div>
                </td>
                <td>{b.statMarket}</td>
                <td>{sideLabel(b.side) || <span className="muted">--</span>}</td>
                {/* A moneyline's "line" is itself an American-odds price -- +130, not 130 -- so it
                    gets the same explicit sign every other price in the app does. */}
                <td className="num">
                  {b.marketType === "MONEYLINE" ? fmtOdds(b.takenLine) : b.takenLine}
                </td>
                <td className="num">
                  {b.avgClosingLine === null ? (
                    <span className="muted">--</span>
                  ) : (
                    <>
                      {b.marketType === "MONEYLINE"
                        ? fmtOdds(Math.round(b.avgClosingLine))
                        : b.avgClosingLine.toFixed(2)}
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
                <td className="num">
                  {b.actualValue === null ? (
                    <span className="muted">--</span>
                  ) : (
                    <>
                      {b.actualValue}
                      {/* A spread's actual is the bet team's margin, measured against the negated
                          handicap. A moneyline's actual is also a margin, but with no handicap --
                          it settles against 0, not the taken price -- so showing takenLine (a
                          price, not a margin) here would misread just as badly. */}
                      <span className="muted" style={{ fontSize: 11 }}>
                        {" "}/{" "}
                        {b.marketType === "SPREAD"
                          ? -b.takenLine
                          : b.marketType === "MONEYLINE"
                            ? 0
                            : b.takenLine}
                      </span>
                    </>
                  )}
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
                  <div>
                    <a
                      className="ext"
                      href={oddsScreenUrlFor(b).url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={
                        oddsScreenUrlFor(b).filteredTo === "sport"
                          ? `${b.sport} odds — pick the market there, then search for the player`
                          : "Odds screen — set the filters there, then search for the player"
                      }
                    >
                      odds ↗
                    </a>
                  </div>
                </td>
                <td>
                  <VerdictBadge beatClv={b.beatClv} status={b.status} />
                </td>
                <td>
                  <ResultBadge gradeResult={b.gradeResult} gradeSource={b.gradeSource} />
                </td>
              </BetRow>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
