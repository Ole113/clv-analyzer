import { getOverviewStats, parseBetFilters, getTimeSeries, type Breakdown } from "@/lib/queries";
import { OverviewChart } from "@/components/overview-chart";
import { Info } from "@/components/info";
import { Signed, Rate, ProblemCount } from "@/components/value";
import { fmtEdge, fmtPct } from "@/components/ui";

export const dynamic = "force-dynamic";

function BreakdownTable({ title, rows }: { title: string; rows: Breakdown[] }) {
  if (!rows.length) return null;
  return (
    <>
      <h2>{title}</h2>
      <table>
        <thead>
          <tr>
            <th>{title}</th>
            <th className="num">Picks</th>
            <th className="num">Beat</th>
            <th className="num">Beat rate</th>
            <th className="num">Avg edge</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              <td className="num">{r.n}</td>
              <td className="num">{r.beat}</td>
              <td className="num">
                <Rate value={r.beatRate} />
              </td>
              <td className="num">
                <Signed value={r.avgEdge} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export default async function OverviewPage() {
  const [stats, series] = await Promise.all([
    getOverviewStats(parseBetFilters(new URLSearchParams())),
    getTimeSeries(),
  ]);
  const { overall, counts } = stats;
  const needsAttention = counts.needsGameTime + counts.unavailable + counts.failed;

  return (
    <main>
      {/* The two numbers that answer "am I actually beating the market?" get the space. */}
      <div className="hero">
        <div className="tile">
          <div className="label">
            Beat CLV
            <Info title="Beat CLV" anchor="beat-rate">
              Share of settled picks where the line moved in your favour before kickoff. Above 50%
              means the market agreed with you more often than not. Pending, unavailable and failed
              picks are excluded entirely.
            </Info>
          </div>
          <div className="value">
            <Rate value={overall.beatRate} />
          </div>
          <div className="sub">
            {overall.beat} of {overall.n} settled picks · avg edge{" "}
            <Signed value={overall.avgEdge} />
          </div>
        </div>
        <div className="tile">
          <div className="label">
            Average EV
            <Info title="Average EV%" anchor="ev">
              <code>fair probability × decimal payout − 1</code>, averaged over picks that carry an
              EV number. The fair probability is the site&apos;s own no-vig figure at your exact
              line. Negative means the pick&apos;em payout did not cover the true odds.
            </Info>
          </div>
          <div className="value">
            <Signed value={overall.avgEv} unit="%" />
          </div>
          <div className="sub">measured against the closing market</div>
        </div>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">Settled</div>
          <div className="value">{counts.closed}</div>
          <div className="sub">closing line captured</div>
        </div>
        <div className="tile">
          <div className="label">Awaiting close</div>
          <div className="value">{counts.pending + counts.due}</div>
          <div className="sub">
            <a href="/bets?group=open">see them</a>
          </div>
        </div>
        <div className="tile">
          <div className="label">
            Needs attention
            <Info title="Needs attention" anchor="late">
              Picks with no kickoff time, props that were no longer quoted at close, and reads that
              failed outright. None of these count toward the rates above.
            </Info>
          </div>
          <div className="value">
            <ProblemCount value={needsAttention} />
          </div>
          <div className="sub">
            {counts.needsGameTime} no kickoff · {counts.unavailable} unavailable · {counts.failed}{" "}
            failed
          </div>
        </div>
        <div className="tile">
          <div className="label">Total picks</div>
          <div className="value">{counts.total}</div>
          <div className="sub">
            <a href="/bets">all picks</a>
          </div>
        </div>
      </div>

      <h2>Over time</h2>
      <OverviewChart series={series} />

      {overall.n === 0 && (
        <p className="muted">
          No settled picks yet. Tick the checkbox on a row in the OddsJam or PropProfessor Fantasy
          Optimizer and the closing line will be read a couple of minutes after kickoff.
        </p>
      )}

      <BreakdownTable title="Sport" rows={stats.bySport} />
      <BreakdownTable title="Site" rows={stats.bySite} />
      <BreakdownTable title="Stat" rows={stats.byStat} />
    </main>
  );
}
