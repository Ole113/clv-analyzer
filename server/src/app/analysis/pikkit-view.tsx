import {
  getPikkitAnalysis,
  getPikkitFacets,
  parsePikkitFilters,
  PIKKIT_TIMEZONE,
  type BreakdownRow,
  type MoneyBlock,
  type PikkitAnalysisResult,
} from "@/lib/pikkit/analysis";
import { importPikkitCsv, purgePikkitBets, countPikkitBets } from "@/lib/pikkit/import";
import { PikkitImportForm } from "@/components/pikkit-import-form";
import { PikkitFilterBar } from "@/components/pikkit-filter-bar";
import { ProfitCurve } from "@/components/profit-curve";
import { DivergingBars, type BarDatum } from "@/components/bars";
import { Signed } from "@/components/value";
import { Info } from "@/components/info";
import { fmtPct, fmtMoney } from "@/components/ui";
import { SortableTable } from "@/components/sortable-table";

/**
 * The Pikkit half of /analysis: a real betting history, measured in money.
 *
 * Every number here is ROI-first. A win rate on its own says almost nothing about a history made
 * mostly of DFS slips -- 38% at an average payout of 7.5 is a large edge, and 48% at 2.0 is a slow
 * bleed -- so ROI leads every table and the win rate rides beside it.
 */

function money(value: number): string {
  return fmtMoney(value);
}

/** Money coloured by sign, in the same good/bad/flat vocabulary `Signed` uses for edges. */
function Money({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">--</span>;
  const cls = value > 0 ? "good" : value < 0 ? "bad" : "flat";
  return (
    <span className={`val ${cls}`}>
      {value > 0 ? "+" : ""}
      {money(value)}
    </span>
  );
}

function Roi({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">--</span>;
  return <Signed value={value * 100} unit="%" digits={1} />;
}

/** The thin-sample marker. Not a filter: a row seen three times is worth seeing, just not trusting. */
function Thin({ row }: { row: BreakdownRow }) {
  if (row.reliable || row.decided === 0) return null;
  return (
    <span className="muted" title="Too few decided bets to read as a signal">
      {" "}
      ·thin
    </span>
  );
}

function BreakdownTable({ rows, unit = "Group" }: { rows: BreakdownRow[]; unit?: string }) {
  return (
    <SortableTable
      rows={rows}
      rowKey={(r) => r.key}
      columns={[
        {
          key: "label",
          label: unit,
          sortValue: (r) => r.label.toLowerCase(),
          render: (r) => (
            <>
              {r.label}
              <Thin row={r} />
            </>
          ),
        },
        { key: "bets", label: "Bets", numeric: true, sortValue: (r) => r.bets, render: (r) => r.bets },
        {
          key: "wl",
          label: "W-L",
          numeric: true,
          sortValue: (r) => r.wins,
          render: (r) => `${r.wins}-${r.losses}`,
        },
        {
          key: "winRate",
          label: "Win %",
          numeric: true,
          sortValue: (r) => r.winRate,
          render: (r) => fmtPct(r.winRate),
        },
        {
          key: "staked",
          label: "Staked",
          numeric: true,
          sortValue: (r) => r.turnover,
          render: (r) => money(r.turnover),
        },
        {
          key: "profit",
          label: "Profit",
          numeric: true,
          sortValue: (r) => r.profit,
          render: (r) => <Money value={r.profit} />,
        },
        { key: "roi", label: "ROI", numeric: true, sortValue: (r) => r.roi, render: (r) => <Roi value={r.roi} /> },
        {
          key: "avgOdds",
          label: "Avg odds",
          numeric: true,
          sortValue: (r) => r.avgOdds,
          render: (r) => (r.avgOdds === null ? "--" : r.avgOdds.toFixed(2)),
        },
      ]}
    />
  );
}

/**
 * ROI bars, in percentage points, with the sample size printed beside the number and the money
 * behind it in the tooltip.
 *
 * Rows are still ranked by raw ROI -- that ranking is the whole point of the chart -- but ROI alone
 * cannot tell a real edge from a small sample that ran hot, and hiding the count behind a hover is
 * how "best performing sport" ends up meaning "54-bet sport that got lucky" next to a 390-bet one
 * sitting lower with a smaller number. The count travels with the value instead, and a row under
 * the reliability floor is dimmed so the eye already knows to discount it before reading the label.
 */
function roiBars(rows: BreakdownRow[]): BarDatum[] {
  return rows
    .filter((r) => r.roi !== null)
    .map((r) => ({
      label: r.label,
      value: (r.roi as number) * 100,
      count: r.decided,
      dim: !r.reliable,
      note: `${r.decided} decided, ${money(r.profit)}${r.reliable ? "" : ", thin sample"}`,
    }));
}

function ChartCard({
  title,
  lede,
  rows,
  emptyNote,
  unit = "Group",
}: {
  title: string;
  lede: string;
  rows: BreakdownRow[];
  emptyNote?: string;
  unit?: string;
}) {
  const data = roiBars(rows);
  return (
    <section className="chart-card">
      <h3>{title}</h3>
      <p className="lede">{lede}</p>
      {data.length > 0 && (
        <div className="legend">
          <span>
            <span className="swatch" style={{ background: "#3987e5" }} />
            Profitable
          </span>
          <span>
            <span className="swatch" style={{ background: "#e66767" }} />
            Losing
          </span>
        </div>
      )}
      <DivergingBars data={data} unit="%" emptyNote={emptyNote ?? "Nothing settled in this cut yet."} />
      {rows.length > 0 && (
        <details>
          <summary>Show the numbers</summary>
          <BreakdownTable rows={rows} unit={unit} />
        </details>
      )}
    </section>
  );
}

function Tiles({ headline, analysis }: { headline: MoneyBlock; analysis: PikkitAnalysisResult }) {
  const { confidence } = analysis;
  return (
    <div className="tiles">
      <div className="tile">
        <div className="label">
          ROI
          <Info title="Return on investment">
            Net profit divided by the stake on decided bets. Voids are excluded from both sides —
            the stake came back, so counting it as money risked would dilute the figure by however
            many games were postponed. Pending bets are excluded entirely.
          </Info>
        </div>
        <div className="value"><Roi value={headline.roi} /></div>
        <div className="sub">{money(headline.turnover)} staked</div>
      </div>
      <div className="tile">
        <div className="label">Profit</div>
        <div className="value"><Money value={headline.profit} /></div>
        <div className="sub">over {headline.decided} decided bets</div>
      </div>
      <div className="tile">
        <div className="label">
          Win rate
          <Info title="Win rate">
            Wins over decided bets. On its own it says very little here: most of these are pick&apos;em
            slips paying 6.0, where winning a third of the time is a large edge. Read it next to
            the average odds, never alone.
          </Info>
        </div>
        <div className="value">
          <span className="val">{fmtPct(headline.winRate)}</span>
        </div>
        <div className="sub">
          {headline.wins}-{headline.losses} at {headline.avgOdds?.toFixed(2) ?? "--"} avg odds
        </div>
      </div>
      <div className="tile">
        <div className="label">
          Is it real?
          <Info title="Confidence in the ROI">
            A 95% interval on the ROI, from a ratio estimator — the right one here, because ROI is
            a ratio of two sums over unequal stakes rather than the mean of a sample. The z-score
            is how many standard errors the ROI sits above break-even; past about 2 the record is
            unlikely to be noise alone. It says nothing about whether the edge persists.
          </Info>
        </div>
        <div className="value">
          {confidence.z === null ? (
            <span className="muted">--</span>
          ) : (
            <Signed value={confidence.z} digits={1} unit="σ" />
          )}
        </div>
        <div className="sub">
          {confidence.low === null || confidence.high === null
            ? "not enough bets"
            : `95% CI ${(confidence.low * 100).toFixed(0)}% to ${(confidence.high * 100).toFixed(0)}%`}
        </div>
      </div>
    </div>
  );
}

export async function PikkitAnalysisView({ params }: { params: URLSearchParams }) {
  const totalImported = await countPikkitBets();

  if (totalImported === 0) {
    return (
      <section className="chart-card">
        <h3>Import your Pikkit history</h3>
        <p className="lede">
          Export <strong>transactions.csv</strong> from Pikkit and drop it in here. Every bet it
          contains is analysed separately from the picks the extension captures — those two datasets
          have almost nothing in common, since this one knows exactly what was staked and returned
          and mostly nothing about the closing line, and the other is the reverse.
        </p>
        <PikkitImportForm
          importAction={importPikkitCsv}
          purgeAction={purgePikkitBets}
          existingCount={0}
        />
        <p className="muted" style={{ marginTop: 14, marginBottom: 0 }}>
          Exports can be dropped in repeatedly, going back as many years as you have. Bets are
          matched on Pikkit&apos;s own bet id, so re-importing updates what is already here rather
          than duplicating it — a bet that was still open last time simply settles.
        </p>
      </section>
    );
  }

  const values = Object.fromEntries(params.entries());
  const [analysis, facets] = await Promise.all([
    getPikkitAnalysis(parsePikkitFilters(params)),
    getPikkitFacets(),
  ]);

  const { headline, closing, expectation, streaks } = analysis;

  if (headline.bets === 0) {
    return (
      <>
        <PikkitFilterBar facets={facets} values={values} />
        <p className="muted">Nothing matches these filters.</p>
      </>
    );
  }

  return (
    <>
      <PikkitFilterBar facets={facets} values={values} />
      <Tiles headline={headline} analysis={analysis} />

      {(headline.pending > 0 || headline.voids > 0 || headline.noRisk > 0) && (
        <p className="muted">
          {headline.pending > 0 && `${headline.pending} still pending. `}
          {headline.voids > 0 && `${headline.voids} voided (no action, excluded from ROI). `}
          {headline.noRisk > 0 &&
            `${headline.noRisk} recorded as a loss with no money lost — a promo or free bet, counted in the win rate but costing nothing in profit.`}
        </p>
      )}

      <section className="chart-card">
        <h3>Profit over time</h3>
        <p className="lede">
          Cumulative net profit by the day the bet was placed, in Mountain time ({PIKKIT_TIMEZONE}).
          The shape matters more than the endpoint: a steady climb and one lucky week ending at the
          same number are completely different processes, and only one of them repeats.
        </p>
        <ProfitCurve series={analysis.series} />
        <details>
          <summary>Show the numbers</summary>
          <SortableTable
            rows={analysis.series}
            rowKey={(p) => p.date}
            columns={[
              { key: "day", label: "Day", sortValue: (p) => p.date, render: (p) => p.date },
              { key: "bets", label: "Bets", numeric: true, sortValue: (p) => p.bets, render: (p) => p.bets },
              {
                key: "profit",
                label: "Profit",
                numeric: true,
                sortValue: (p) => p.profit,
                render: (p) => <Money value={p.profit} />,
              },
              {
                key: "running",
                label: "Running total",
                numeric: true,
                sortValue: (p) => p.cumulativeProfit,
                render: (p) => <Money value={p.cumulativeProfit} />,
              },
              {
                key: "runningRoi",
                label: "Running ROI",
                numeric: true,
                sortValue: (p) => p.cumulativeRoi,
                render: (p) => <Roi value={p.cumulativeRoi} />,
              },
            ]}
          />
        </details>
      </section>

      <ChartCard
        title="By sportsbook"
        lede="ROI per book. Books differ in what they let you bet and at what price, so this is the closest thing to a ranking of where the edge actually is."
        rows={analysis.byBook}
        unit="Sportsbook"
      />

      <div className="grid-2">
        <ChartCard
          title="Straight vs slip"
          lede="Whether the single bets or the multi-leg slips have carried the account."
          rows={analysis.byBetType}
          unit="Type"
        />
        <ChartCard
          title="By number of legs"
          lede="How ROI moves as legs are added. More legs means more variance, so read these against their sample sizes."
          rows={analysis.byLegCount}
          unit="Legs"
        />
      </div>

      <h2>What you bet on</h2>

      <div className="grid-2">
        <ChartCard
          title="By league"
          lede="A slip spanning two leagues counts under both, with its whole stake, so these do not sum to the total."
          rows={analysis.byLeague}
          unit="League"
        />
        <ChartCard
          title="By sport"
          lede="Same counting as leagues: a mixed-sport slip appears under each sport it touches."
          rows={analysis.bySport}
          unit="Sport"
        />
      </div>

      <section className="chart-card">
        <h3>
          By market
          <Info title="Why this is exposure, not a hit rate">
            A Pikkit export settles the whole slip and never the individual legs, so there is no
            such thing as a per-leg win or loss in this data. What a row here says is: of the slips
            that contained at least one leg on this market, this is what they returned. A three-leg
            slip appears under all three of its markets, at its full stake. It is a weaker claim
            than a market hit rate, and it is the strongest one this export supports.
          </Info>
        </h3>
        <p className="lede">
          Slips containing a leg on each market, and what those slips returned.{" "}
          {analysis.legsParsed} of {analysis.legsTotal} legs were readable.
        </p>
        <div className="legend">
          <span>
            <span className="swatch" style={{ background: "#3987e5" }} />
            Profitable
          </span>
          <span>
            <span className="swatch" style={{ background: "#e66767" }} />
            Losing
          </span>
        </div>
        <DivergingBars data={roiBars(analysis.byMarket)} unit="%" emptyNote="No legs parsed into a known market yet." />
        {analysis.byMarket.length > 0 && (
          <details>
            <summary>Show the numbers</summary>
            <BreakdownTable rows={analysis.byMarket} unit="Market" />
          </details>
        )}
      </section>

      <div className="grid-2">
        <ChartCard
          title="Over vs under"
          lede="Slips by the side their legs took — Over and Higher on one side, Under and Lower on the other. A slip with both appears under both."
          rows={analysis.bySide}
          unit="Side"
        />
        <ChartCard
          title="Most-bet players"
          lede="Players you have real exposure to, by the return of the slips their legs appeared in."
          rows={analysis.byPlayer.slice(0, 12)}
          emptyNote="No player has enough decided bets yet."
          unit="Player"
        />
      </div>

      <h2>When you bet</h2>

      <div className="grid-2">
        <ChartCard
          title="By day of the week"
          lede={`Placed-at day in Mountain time (${PIKKIT_TIMEZONE}) — your own clock, not the export's UTC.`}
          rows={analysis.byWeekday}
          unit="Day"
        />
        <ChartCard
          title="By hour of the day"
          lede="Late-night bets go in against thinner, less efficient markets than a Sunday morning slate. This is whether that shows up in the record."
          rows={analysis.byHour.filter((r) => r.bets > 0)}
          unit="Hour"
        />
      </div>

      <div className="grid-2">
        <ChartCard
          title="By month"
          lede="The long view, and the one that matters once several years of exports are loaded."
          rows={analysis.byMonth}
          unit="Month"
        />
        <ChartCard
          title="Live vs pre-match"
          lede="Bets tagged Live were placed mid-game, into a market that has already moved."
          rows={analysis.byLive}
          unit="When"
        />
      </div>

      <h2>How you bet</h2>

      <div className="grid-2">
        <ChartCard
          title="By price"
          lede="ROI across decimal-odds bands. A long-shot band that looks superb over a handful of bets is almost always variance, so watch the sample."
          rows={analysis.byOdds}
          unit="Odds"
        />
        <ChartCard
          title="By stake size"
          lede="Whether the bets you sized up were the ones worth sizing up."
          rows={analysis.byStake}
          unit="Stake"
        />
      </div>

      <h2>Closing line, where the book reports one</h2>

      <section className="chart-card">
        <h3>
          Did the price move your way?
          <Info title="Price-based CLV" anchor="beat-rate">
            Pikkit records a closing price for some books and not others. Where it has one, a bet
            beat the close if the price taken was longer than the price at close. The edge is the
            gap between the two implied probabilities, in percentage points. This is a price
            comparison, not the line-based CLV the captured picks are scored on, and the two are
            not directly comparable.
          </Info>
        </h3>
        <p className="lede">
          {closing.n} of {closing.total} bets in this cut carry both a closing price and a decided
          result. Everything in this section is over that subset only.
        </p>
        {closing.n === 0 ? (
          <p className="muted">None of these bets have a closing price recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th className="num">Bets</th>
                <th className="num">Win %</th>
                <th className="num">Staked</th>
                <th className="num">Profit</th>
                <th className="num">ROI</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Beat the close</td>
                <td className="num">{closing.beat.decided}</td>
                <td className="num">{fmtPct(closing.beat.winRate)}</td>
                <td className="num">{money(closing.beat.turnover)}</td>
                <td className="num"><Money value={closing.beat.profit} /></td>
                <td className="num"><Roi value={closing.beat.roi} /></td>
              </tr>
              <tr>
                <td>Missed the close</td>
                <td className="num">{closing.missed.decided}</td>
                <td className="num">{fmtPct(closing.missed.winRate)}</td>
                <td className="num">{money(closing.missed.turnover)}</td>
                <td className="num"><Money value={closing.missed.profit} /></td>
                <td className="num"><Roi value={closing.missed.roi} /></td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>
                  Beat rate {fmtPct(closing.beatRate)}, average price edge{" "}
                  <Signed value={closing.avgPriceEdgePts} unit=" pts" digits={2} />
                </td>
                <td className="num" colSpan={5}>
                  {closing.lift === null ? (
                    <span className="muted">--</span>
                  ) : (
                    <>
                      ROI lift from beating the close: <Signed value={closing.lift} unit="%" digits={1} />
                    </>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>

      <section className="chart-card">
        <h3>
          Expected versus actual
          <Info title="Pikkit's EV against the result">
            Pikkit computes an EV for some bets. Multiplying each by its stake gives the profit
            those bets &quot;should&quot; have produced; the gap to what they actually produced is
            variance — running hot or cold against the edge the numbers claim. Only bets carrying
            both an EV and a decided result can appear, or the two sides would be measured over
            different samples.
          </Info>
        </h3>
        <p className="lede">
          {expectation.n} of {expectation.total} bets in this cut carry an EV from Pikkit.
        </p>
        {expectation.n === 0 ? (
          <p className="muted">None of these bets carry an EV figure.</p>
        ) : (
          <div className="tiles" style={{ marginBottom: 0 }}>
            <div className="tile">
              <div className="label">Expected profit</div>
              <div className="value"><Money value={expectation.expectedProfit} /></div>
              <div className="sub"><Roi value={expectation.expectedRoi} /> expected ROI</div>
            </div>
            <div className="tile">
              <div className="label">Actual profit</div>
              <div className="value"><Money value={expectation.actualProfit} /></div>
              <div className="sub"><Roi value={expectation.actualRoi} /> actual ROI</div>
            </div>
            <div className="tile">
              <div className="label">Running above/below</div>
              <div className="value"><Money value={expectation.deltaProfit} /></div>
              <div className="sub">actual minus expected</div>
            </div>
            <div className="tile">
              <div className="label">Streaks</div>
              <div className="value">
                {streaks.longestWin}W / {streaks.longestLoss}L
              </div>
              <div className="sub">
                {streaks.current === 0
                  ? "no run in flight"
                  : `currently ${Math.abs(streaks.current)} ${streaks.current > 0 ? "win" : "loss"}${Math.abs(streaks.current) === 1 ? "" : "es"} in a row`}
              </div>
            </div>
          </div>
        )}
      </section>

      <details className="chart-card">
        <summary className="muted">Import another export</summary>
        <p className="lede" style={{ marginTop: 12 }}>
          Bets are matched on Pikkit&apos;s own bet id, so re-importing updates what is already here
          rather than duplicating it.
        </p>
        <PikkitImportForm
          importAction={importPikkitCsv}
          purgeAction={purgePikkitBets}
          existingCount={totalImported}
        />
      </details>
    </>
  );
}
