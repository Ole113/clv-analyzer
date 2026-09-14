import type { SeriesPoint } from "@/lib/pikkit/analysis";

const W = 720;
const H = 220;
const PAD = { top: 14, right: 58, bottom: 26, left: 52 };

/**
 * Cumulative profit over time.
 *
 * A line, because the job is change-over-time, and one series only -- profit and ROI are on
 * different scales and putting both here would need a second y-axis, which is never right. ROI
 * gets its own column in the table underneath instead.
 *
 * Reuses the `.ts-*` marks the overview chart already defines: 2px line, recessive grid, dots
 * ringed in the surface colour so overlapping days stay separable, and a palette already checked
 * against both themes. A single series needs no legend -- the heading names it -- so the only
 * direct label is the final value, which is the number the whole chart exists to show.
 *
 * Deliberately a Server Component: there is nothing to pick and nothing to toggle, so shipping
 * JavaScript for it would buy nothing.
 */
export function ProfitCurve({ series }: { series: SeriesPoint[] }) {
  if (series.length < 2) {
    return (
      <p className="muted" style={{ marginBottom: 0 }}>
        Not enough settled days to plot a curve yet — at least two are needed.
      </p>
    );
  }

  const values = series.map((p) => p.cumulativeProfit);
  let min = Math.min(...values, 0);
  let max = Math.max(...values, 0);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const padY = (max - min) * 0.12;
  min -= padY;
  max += padY;

  const x = (i: number) => PAD.left + (i / (series.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);

  const path = series
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.cumulativeProfit).toFixed(1)}`)
    .join(" ");

  const ticks = [max, (max + min) / 2, min];
  const labelEvery = Math.ceil(series.length / 6);
  // Past about sixty days the dots merge into a band and stop meaning anything individually, so
  // beyond that the line carries it alone and only the endpoint keeps its marker.
  const showDots = series.length <= 60;
  const last = series[series.length - 1];

  return (
    <svg className="ts" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative profit over time; the same figures are listed in the table below.">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={PAD.left} y1={y(t)} x2={W - PAD.right} y2={y(t)} className="ts-grid" />
          <text x={PAD.left - 8} y={y(t) + 3} className="ts-axis" textAnchor="end">
            {`${t < 0 ? "-" : ""}$${Math.abs(t).toFixed(0)}`}
          </text>
        </g>
      ))}

      {/* Break-even. The anchor the whole chart is read against, so it is drawn over the grid. */}
      <line x1={PAD.left} y1={y(0)} x2={W - PAD.right} y2={y(0)} className="ts-zero" />

      <path d={path} className="ts-line" />

      {showDots &&
        series.map((p, i) => (
          <circle key={p.date} cx={x(i)} cy={y(p.cumulativeProfit)} r={3.5} className="ts-dot">
            <title>{`${p.date}: ${p.cumulativeProfit >= 0 ? "+" : ""}$${p.cumulativeProfit.toFixed(2)} after ${p.bets} settled bet${p.bets === 1 ? "" : "s"}`}</title>
          </circle>
        ))}

      {!showDots && (
        <circle cx={x(series.length - 1)} cy={y(last.cumulativeProfit)} r={3.5} className="ts-dot">
          <title>{`${last.date}: ${last.cumulativeProfit >= 0 ? "+" : ""}$${last.cumulativeProfit.toFixed(2)}`}</title>
        </circle>
      )}

      <text x={x(series.length - 1) + 8} y={y(last.cumulativeProfit) + 4} className="bars-value">
        {`${last.cumulativeProfit >= 0 ? "+" : "-"}$${Math.abs(last.cumulativeProfit).toFixed(0)}`}
      </text>

      {series.map((p, i) =>
        i % labelEvery === 0 ? (
          <text key={p.date} x={x(i)} y={H - 8} className="ts-axis" textAnchor="middle">
            {p.date.slice(5)}
          </text>
        ) : null
      )}
    </svg>
  );
}
