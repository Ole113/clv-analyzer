import { getAnalysis } from "@/lib/analysis";
import { getFacets, parseBetFilters } from "@/lib/queries";
import { FilterBar } from "@/components/filter-bar";
import { DivergingBars, Histogram, type BarDatum } from "@/components/bars";
import { MIN_RELIABLE_PICKS } from "@/lib/analysis";
import { fmtEdge, fmtPct, sideLabel } from "@/components/ui";
import { Signed, Rate } from "@/components/value";
import { BREAK_EVEN_RATE } from "@/lib/ev";
import { Info } from "@/components/info";

export const dynamic = "force-dynamic";

function Legend() {
  return (
    <div className="legend">
      <span>
        <span className="swatch" style={{ background: "#3987e5" }} />
        In your favour
      </span>
      <span>
        <span className="swatch" style={{ background: "#e66767" }} />
        Against you
      </span>
    </div>
  );
}

function ChartCard({
  title,
  lede,
  data,
  unit,
  emptyNote,
  table,
}: {
  title: string;
  lede: string;
  data: BarDatum[];
  unit: string;
  emptyNote?: string;
  table: React.ReactNode;
}) {
  return (
    <section className="chart-card">
      <h3>{title}</h3>
      <p className="lede">{lede}</p>
      {data.length > 0 && <Legend />}
      <DivergingBars data={data} unit={unit} emptyNote={emptyNote} />
      {data.length > 0 && (
        <details>
          <summary>Show the numbers</summary>
          {table}
        </details>
      )}
    </section>
  );
}

export default async function AnalysisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v) params.set(k, v);
  const minSample = Math.max(1, Number(params.get("minSample") ?? 1));

  const values = Object.fromEntries(params.entries());
  const [analysis, facets] = await Promise.all([
    getAnalysis({ ...parseBetFilters(params), minSample }),
    getFacets(),
  ]);

  const best = analysis.byStat.filter((s) => (s.avgEv ?? 0) > 0);
  const worst = [...analysis.byStat].filter((s) => (s.avgEv ?? 0) < 0).reverse();
  const bestSide = [...analysis.bySide].sort((a, b) => (b.avgEv ?? -Infinity) - (a.avgEv ?? -Infinity))[0];

  const propTable = (rows: typeof analysis.byStat) => (
    <table>
      <thead>
        <tr>
          <th>Prop</th>
          <th className="num">Picks</th>
          <th className="num">Beat CLV</th>
          <th className="num">Hit rate</th>
          <th className="num">Avg edge</th>
          <th className="num">Avg EV%</th>
          <th className="num">EV gained</th>
          <th className="num">EV lost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.key}</td>
            <td className="num">{r.n}</td>
            <td className="num"><Rate value={r.beatRate} /></td>
            <td className="num">
              <Rate value={r.hitRate} threshold={BREAK_EVEN_RATE} />
              {r.decided > 0 && (
                <span className="muted" style={{ fontSize: 11 }}> ({r.wins}-{r.losses})</span>
              )}
            </td>
            <td className="num"><Signed value={r.avgEdge} /></td>
            <td className="num"><Signed value={r.avgEv} unit="%" /></td>
            <td className="num"><Signed value={r.evGained} unit="%" digits={1} /></td>
            <td className="num"><Signed value={r.evLost} unit="%" digits={1} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Analysis</h2>
        <FilterBar facets={facets} values={values} action="/analysis" showVerdict showResult />

      <div className="tiles">
        <div className="tile">
          <div className="label">Settled picks</div>
          <div className="value">{analysis.sampleSize}</div>
          <div className="sub">
            {analysis.withEv} with EV% · {analysis.gradedSample} graded
          </div>
        </div>
        <div className="tile">
          <div className="label">
            Beat CLV
            <Info title="Beat CLV" anchor="clv">
              Over beats the close when the line moved up; Under when it moved down. A flat line
              does not count as a win.
            </Info>
          </div>
          <div className="value"><Rate value={analysis.overall.beatRate} /></div>
          <div className="sub">line moved your way</div>
        </div>
        <div className="tile">
          <div className="label">
            Hit rate
            <Info title="Hit rate" anchor="break-even">
              Wins divided by decided picks. Pushes and voids are excluded from both sides rather
              than counted as losses. Coloured against break-even ({(BREAK_EVEN_RATE * 100).toFixed(1)}%),
              not 50% — at a standard pick&apos;em price you must win more than half just to be flat.
            </Info>
          </div>
          <div className="value">
            <Rate value={analysis.overall.hitRate} threshold={BREAK_EVEN_RATE} />
          </div>
          <div className="sub">
            {analysis.overall.wins}-{analysis.overall.losses} over {analysis.gradedSample} graded
          </div>
        </div>
        <div className="tile">
          <div className="label">
            Avg EV%
            <Info title="Average EV%" anchor="ev">
              Fair probability from the site&apos;s own no-vig column, times the decimal payout,
              minus one. Averaged over picks that carry an EV number.
            </Info>
          </div>
          <div className="value"><Signed value={analysis.overall.avgEv} unit="%" /></div>
          <div className="sub">vs the closing market</div>
        </div>
        <div className="tile">
          <div className="label">Better side</div>
          <div className="value">{bestSide?.n ? sideLabel(bestSide.side) : "--"}</div>
          <div className="sub">
            {bestSide?.n
              ? `${bestSide.avgEv === null ? "--" : `${bestSide.avgEv.toFixed(2)}%`} EV over ${bestSide.n} picks`
              : "no settled picks yet"}
          </div>
        </div>
      </div>

      {analysis.withEv === 0 && analysis.sampleSize > 0 && (
        <p className="muted">
          None of these picks carry an EV% yet — EV needs the site&apos;s own fair-probability
          column, which is only captured on picks taken after that change. CLV edge below is
          unaffected.
        </p>
      )}

      <ChartCard
        title="Best prop types"
        lede="Average EV% against the closing market, by prop. These are the props worth keeping in the rotation."
        data={best.map((s) => ({ label: s.key, value: s.avgEv ?? 0, note: `${s.n} picks` }))}
        unit="%"
        emptyNote="No prop type is averaging positive EV yet."
        table={propTable(best)}
      />

      <ChartCard
        title="Props to avoid"
        lede="Prop types averaging negative EV against the close, worst first, with the total EV given up on each."
        data={worst.map((s) => ({
          label: s.key,
          value: s.avgEv ?? 0,
          note: `${s.n} picks, ${s.evLost.toFixed(1)}% lost`,
        }))}
        unit="%"
        emptyNote="No prop type is averaging negative EV. "
        table={propTable(worst)}
      />

      <div className="grid-2">
        <ChartCard
          title="Worst sportsbooks overall"
          lede="How each book's closing number compared with the consensus, in line units. Negative means the book habitually hung a worse number than the market for the side you were on."
          data={analysis.worstBooks
            .slice(0, 10)
            .map((b) => ({ label: b.label, value: b.avgFavorability, note: `${b.n} lines` }))}
          unit=""
          emptyNote="No closing book lines captured yet."
          table={
            <table>
              <thead>
                <tr>
                  <th>Book</th>
                  <th className="num">Lines</th>
                  <th className="num">Avg vs consensus</th>
                </tr>
              </thead>
              <tbody>
                {analysis.worstBooks.map((b) => (
                  <tr key={b.bookKey}>
                    <td>{b.label}</td>
                    <td className="num">{b.n}</td>
                    <td className="num"><Signed value={b.avgFavorability} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />

        <section className="chart-card">
          <h3>Over vs Under</h3>
          <p className="lede">Which side has actually been paying, across the filtered picks.</p>
          <table>
            <thead>
              <tr>
                <th>Side</th>
                <th className="num">Picks</th>
                <th className="num">Beat CLV</th>
                <th className="num">Hit rate</th>
                <th className="num">Avg edge</th>
                <th className="num">Avg EV%</th>
              </tr>
            </thead>
            <tbody>
              {analysis.bySide.map((s) => (
                <tr key={s.side}>
                  <td>{sideLabel(s.side)}</td>
                  <td className="num">{s.n}</td>
                  <td className="num"><Rate value={s.beatRate} /></td>
                  <td className="num">
                    <Rate value={s.hitRate} threshold={BREAK_EVEN_RATE} />
                  </td>
                  <td className="num"><Signed value={s.avgEdge} /></td>
                  <td className="num"><Signed value={s.avgEv} unit="%" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <h2>How your edge is distributed</h2>
      <p className="lede muted" style={{ fontSize: 12, marginTop: -4 }}>
        The average edge above hides its own shape. A mean of +0.2 can be a steady small win on most
        picks, or a pile of small losses rescued by two big ones — the second is variance, not a
        method. Buckets are in line units, half-open, and a pick landing exactly flat counts in
        &quot;0 to 0.5&quot;.
      </p>
      <section className="chart-card">
        <Histogram
          data={analysis.edgeHistogram.map((b) => ({
            label: b.key,
            count: b.picks,
            sign: (b.to !== null && b.to <= 0 ? -1 : b.from !== null && b.from >= 0 ? 1 : 0) as -1 | 0 | 1,
            note: `${(b.share * 100).toFixed(1)}% of scored picks`,
          }))}
          emptyNote="No pick has a CLV edge yet — this needs picks whose closing line was captured."
        />
        {analysis.edgeHistogram.some((b) => b.picks > 0) && (
          <details>
            <summary>Show the numbers</summary>
            <table>
              <thead>
                <tr>
                  <th>Edge</th>
                  <th className="num">Picks</th>
                  <th className="num">Share</th>
                </tr>
              </thead>
              <tbody>
                {analysis.edgeHistogram.map((b) => (
                  <tr key={b.key}>
                    <td>{b.key}</td>
                    <td className="num">{b.picks}</td>
                    <td className="num">{(b.share * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      <h2>When you take the pick</h2>
      <p className="lede muted" style={{ fontSize: 12, marginTop: -4 }}>
        CLV against how far ahead of kickoff the pick was captured. Taking a number days early means
        beating a market that has not formed yet; taking it minutes out means beating one that has
        already absorbed the news. Live picks and picks with no kickoff time have no lead time to
        measure and do not appear.
      </p>
      <ChartCard
        title="Average edge by lead time"
        lede="Line units gained, per bucket of hours before kickoff."
        data={analysis.timing
          .filter((t) => t.picks > 0)
          .map((t) => ({ label: t.key, value: t.avgEdge ?? 0, note: `${t.picks} picks` }))}
        unit=""
        emptyNote="No settled pick carries both a kickoff time and a CLV verdict yet."
        table={
          <table>
            <thead>
              <tr>
                <th>Before kickoff</th>
                <th className="num">Picks</th>
                <th className="num">Beat CLV</th>
                <th className="num">Hit rate</th>
                <th className="num">Avg edge</th>
                <th className="num">Avg EV%</th>
              </tr>
            </thead>
            <tbody>
              {analysis.timing.map((t) => (
                <tr key={t.key}>
                  <td>{t.key}</td>
                  <td className="num">{t.picks}</td>
                  <td className="num"><Rate value={t.beatRate} /></td>
                  <td className="num"><Rate value={t.hitRate} threshold={BREAK_EVEN_RATE} /></td>
                  <td className="num"><Signed value={t.avgEdge} /></td>
                  <td className="num"><Signed value={t.avgEv} unit="%" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        }
      />

      <h2>Scorecards</h2>
      <p className="lede muted" style={{ fontSize: 12, marginTop: -4 }}>
        Not the same question as &quot;worst sportsbooks&quot; above. That ranks how good a
        book&apos;s closing <em>number</em> was against the consensus; this asks whether the picks it
        was quoting went on to beat the close. A book can hang a generous number and still be
        quoting markets that move against you. Rows under {MIN_RELIABLE_PICKS} picks are greyed:
        a 100% beat rate over two picks is noise, not a finding.
      </p>

      <div className="grid-2">
        <section className="chart-card">
          <h3>By book</h3>
          <p className="lede">Picks each book was quoting at close, and how those picks turned out.</p>
          {analysis.bookScorecard.length === 0 ? (
            <p className="muted">No closing book lines captured yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Book</th>
                  <th className="num">Picks</th>
                  <th className="num">Beat CLV</th>
                  <th className="num">Avg edge</th>
                  <th className="num">Avg EV%</th>
                </tr>
              </thead>
              <tbody>
                {analysis.bookScorecard.map((b) => (
                  <tr key={b.bookKey} className={b.reliable ? "" : "excluded"}>
                    <td>
                      {b.label}
                      {!b.reliable && (
                        <span className="muted" style={{ fontSize: 11 }}> · thin sample</span>
                      )}
                    </td>
                    <td className="num">{b.picks}</td>
                    <td className="num"><Rate value={b.beatRate} /></td>
                    <td className="num"><Signed value={b.avgEdge} /></td>
                    <td className="num"><Signed value={b.avgEv} unit="%" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="chart-card">
          <h3>By market</h3>
          <p className="lede">The same ranking per prop type, ordered by how often it beat the close.</p>
          {analysis.marketScorecard.length === 0 ? (
            <p className="muted">No settled picks yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="num">Picks</th>
                  <th className="num">Beat CLV</th>
                  <th className="num">Hit rate</th>
                  <th className="num">Avg edge</th>
                </tr>
              </thead>
              <tbody>
                {analysis.marketScorecard.map((m) => (
                  <tr key={m.statMarket} className={m.reliable ? "" : "excluded"}>
                    <td>
                      {m.statMarket}
                      {!m.reliable && (
                        <span className="muted" style={{ fontSize: 11 }}> · thin sample</span>
                      )}
                    </td>
                    <td className="num">{m.picks}</td>
                    <td className="num"><Rate value={m.beatRate} /></td>
                    <td className="num"><Rate value={m.hitRate} threshold={BREAK_EVEN_RATE} /></td>
                    <td className="num"><Signed value={m.avgEdge} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <h2>Running above or below expectation</h2>
      <p className="lede muted" style={{ fontSize: 12, marginTop: -4 }}>
        Your EV% says what these picks should have returned on average. This compares that with
        what they actually returned, over the picks that are both graded and carry an EV number —
        the gap is variance, not skill.
      </p>
      {analysis.expectation.n === 0 ? (
        <p className="muted">
          Needs picks that are both graded and carry an EV% — none yet.
        </p>
      ) : (
        <div className="tiles" style={{ marginBottom: 26 }}>
          <div className="tile">
            <div className="label">
              Expected
              <Info title="Expected return" anchor="expectation">
                The sum of each pick&apos;s EV%, at one unit staked per pick. This is what the
                edge you were getting says the picks should have returned on average.
              </Info>
            </div>
            <div className="value">
              <Signed value={analysis.expectation.expectedUnits} unit="u" />
            </div>
            <div className="sub">over {analysis.expectation.n} graded picks</div>
          </div>
          <div className="tile">
            <div className="label">Actual</div>
            <div className="value">
              <Signed value={analysis.expectation.actualUnits} unit="u" />
            </div>
            <div className="sub">at the pick&apos;em payout, 1u per pick</div>
          </div>
          <div className="tile">
            <div className="label">
              Difference
              <Info title="Above or below expectation" anchor="expectation">
                Actual minus expected. Positive means you have run better than your edge implies,
                negative means worse. Over a small sample this is almost entirely luck — it says
                nothing about whether the picks were good.
              </Info>
            </div>
            <div className="value">
              <Signed value={analysis.expectation.deltaUnits} unit="u" />
            </div>
            <div className="sub">
              {analysis.expectation.deltaUnits > 0 ? "running hot" : analysis.expectation.deltaUnits < 0 ? "running cold" : "exactly to expectation"}
            </div>
          </div>
          <div className="tile">
            <div className="label">Hit rate vs expected</div>
            <div className="value">
              <Rate value={analysis.expectation.actualHitRate} threshold={analysis.expectation.expectedHitRate ?? BREAK_EVEN_RATE} />
            </div>
            <div className="sub">
              model expected{" "}
              {analysis.expectation.expectedHitRate === null
                ? "--"
                : `${(analysis.expectation.expectedHitRate * 100).toFixed(1)}%`}
            </div>
          </div>
        </div>
      )}

      <h2>Does beating CLV predict hitting?</h2>
      <p className="lede muted" style={{ fontSize: 12, marginTop: -4 }}>
        CLV is only worth tracking if it forecasts results. This compares how often picks that beat
        the close actually won against those that did not — over picks that have both a CLV verdict
        and a decided result.
      </p>
      {analysis.clvVsResult.overall.beat.n + analysis.clvVsResult.overall.missed.n === 0 ? (
        <p className="muted">
          Nothing to compare yet — this needs picks that are both settled for CLV and graded.
        </p>
      ) : (
        <>
          <ChartCard
            title="CLV lift by sport"
            lede="Percentage points of hit rate gained by beating the close. Positive means CLV predicted hitting for that sport."
            data={analysis.clvVsResult.bySport
              .filter((b) => b.lift !== null)
              .map((b) => ({
                label: b.key,
                value: b.lift as number,
                note: `${b.beat.n} beat / ${b.missed.n} missed`,
              }))}
            unit="pp"
            emptyNote="Not enough picks with both a CLV verdict and a result yet."
            table={
              <table>
                <thead>
                  <tr>
                    <th>Sport</th>
                    <th className="num">Beat CLV hit rate</th>
                    <th className="num">Missed CLV hit rate</th>
                    <th className="num">Lift</th>
                  </tr>
                </thead>
                <tbody>
                  {[analysis.clvVsResult.overall, ...analysis.clvVsResult.bySport].map((b) => (
                    <tr key={b.key}>
                      <td>{b.key}</td>
                      <td className="num">
                        <Rate value={b.beat.hitRate} threshold={BREAK_EVEN_RATE} />
                        <span className="muted" style={{ fontSize: 11 }}> (n={b.beat.n})</span>
                      </td>
                      <td className="num">
                        <Rate value={b.missed.hitRate} threshold={BREAK_EVEN_RATE} />
                        <span className="muted" style={{ fontSize: 11 }}> (n={b.missed.n})</span>
                      </td>
                      <td className="num">
                        <Signed value={b.lift} unit="pp" digits={1} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          />
          <p className="muted" style={{ fontSize: 12 }}>
            Treat small n with suspicion: a handful of picks can show a large lift purely by chance.
          </p>
        </>
      )}

      <h2>Worst book per prop type</h2>
      <p className="lede muted" style={{ fontSize: 12, marginTop: -4 }}>
        The book that hung the least favourable closing number for each prop — i.e. where not to
        take that prop next time.
      </p>
      {analysis.worstBooksByStat.length === 0 ? (
        <p className="muted">No closing book lines captured yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Prop</th>
              <th>Worst book</th>
              <th className="num">Avg vs consensus</th>
              <th>Best book</th>
              <th className="num">Avg vs consensus</th>
            </tr>
          </thead>
          <tbody>
            {analysis.worstBooksByStat.map(({ stat, books }) => {
              const worstBook = books[0];
              const bestBook = books[books.length - 1];
              return (
                <tr key={stat}>
                  <td>{stat}</td>
                  <td>
                    {worstBook.label}{" "}
                    <span className="muted" style={{ fontSize: 11 }}>({worstBook.n})</span>
                  </td>
                  <td className="num">{fmtEdge(worstBook.avgFavorability)}</td>
                  <td>
                    {bestBook.label}{" "}
                    <span className="muted" style={{ fontSize: 11 }}>({bestBook.n})</span>
                  </td>
                  <td className="num"><Signed value={bestBook.avgFavorability} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
