/**
 * Horizontal diverging bar chart.
 *
 * Signed magnitude, so the encoding is diverging (blue positive / red negative around a neutral
 * zero rule) rather than categorical. Values are direct-labelled at the end of each bar, every
 * mark carries a <title> for hover, and the caller pairs it with a table -- identity and value are
 * never carried by colour alone.
 */
export interface BarDatum {
  label: string;
  value: number;
  /** Shown in the tooltip and after the label, e.g. sample size. */
  note?: string;
}

export interface HistogramDatum {
  label: string;
  count: number;
  /** Sign of the bucket itself, which is what colours the column -- not the count. */
  sign: -1 | 0 | 1;
  note?: string;
}

const HIST_H = 150;
const COL_W = 46;
const HIST_PAD = 34;

/**
 * Vertical histogram for a distribution.
 *
 * Separate from DivergingBars because the encodings differ: there, length is a signed value read
 * against a zero rule; here, height is a count and the sign lives in the bucket's position along
 * the axis. Sharing one component would mean one of the two lying about what its bars mean.
 *
 * Columns are still coloured by which side of zero their bucket sits on, so the skew of the
 * distribution is legible at a glance -- but the bucket labels run along the axis, so colour is
 * never the only thing carrying it.
 */
export function Histogram({
  data,
  emptyNote = "Not enough settled picks yet.",
}: {
  data: HistogramDatum[];
  emptyNote?: string;
}) {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) return <p className="muted">{emptyNote}</p>;

  const peak = Math.max(...data.map((d) => d.count), 1);
  const width = data.length * COL_W;
  const height = HIST_H + HIST_PAD;

  return (
    <svg
      className="bars"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Histogram; the same counts are listed in the table below."
      preserveAspectRatio="xMinYMin meet"
    >
      {data.map((d, i) => {
        const h = (d.count / peak) * (HIST_H - 16);
        const x = i * COL_W;
        const y = HIST_H - h;
        return (
          <g key={d.label}>
            <title>{`${d.label}: ${d.count} pick${d.count === 1 ? "" : "s"}${d.note ? ` (${d.note})` : ""}`}</title>
            <rect
              x={x + 4}
              y={y}
              width={COL_W - 8}
              height={Math.max(h, d.count > 0 ? 2 : 0)}
              rx={3}
              className={d.sign < 0 ? "bar-neg" : d.sign > 0 ? "bar-pos" : "bar-flat"}
            />
            {d.count > 0 && (
              <text x={x + COL_W / 2} y={y - 4} className="bars-value" textAnchor="middle">
                {d.count}
              </text>
            )}
            <text
              x={x + COL_W / 2}
              y={HIST_H + 14}
              className="bars-label"
              textAnchor="middle"
              style={{ fontSize: 10 }}
            >
              {d.label}
            </text>
          </g>
        );
      })}
      {/* Baseline, drawn last so the columns sit on it rather than over it. */}
      <line x1={0} y1={HIST_H} x2={width} y2={HIST_H} className="bars-zero" />
    </svg>
  );
}

const ROW_H = 26;
const BAR_H = 13;
const LABEL_W = 190;
const VALUE_W = 66;

export function DivergingBars({
  data,
  unit = "",
  emptyNote = "Not enough settled picks yet.",
  max,
}: {
  data: BarDatum[];
  unit?: string;
  emptyNote?: string;
  max?: number;
}) {
  if (data.length === 0) return <p className="muted">{emptyNote}</p>;

  const extent = max ?? Math.max(...data.map((d) => Math.abs(d.value)), 0.0001);
  const plotW = 420;
  const zeroX = LABEL_W + plotW / 2;
  const scale = (v: number) => (v / extent) * (plotW / 2);
  const height = data.length * ROW_H + 18;
  const width = LABEL_W + plotW + VALUE_W;

  return (
    <svg
      className="bars"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Diverging bar chart; the same values are listed in the table below."
      preserveAspectRatio="xMinYMin meet"
    >
      {/* zero rule -- recessive, but the anchor the whole chart is read against */}
      <line x1={zeroX} y1={4} x2={zeroX} y2={height - 14} className="bars-zero" />

      {data.map((d, i) => {
        const y = i * ROW_H + 6;
        const w = Math.abs(scale(d.value));
        const x = d.value >= 0 ? zeroX : zeroX - w;
        const positive = d.value >= 0;
        return (
          <g key={d.label}>
            {/* One text child: multiple JSX expressions here produce differing text nodes
                between server and client and trip React's hydration check. */}
            <title>{`${d.label}: ${d.value > 0 ? "+" : ""}${d.value.toFixed(2)}${unit}${d.note ? ` (${d.note})` : ""}`}</title>
            <text x={LABEL_W - 10} y={y + BAR_H - 1} className="bars-label" textAnchor="end">
              {d.label.length > 30 ? `${d.label.slice(0, 29)}…` : d.label}
            </text>
            <rect
              x={x}
              y={y}
              width={Math.max(w, 1.5)}
              height={BAR_H}
              rx={3}
              className={positive ? "bar-pos" : "bar-neg"}
            />
            {/* Values live in their own right-hand column rather than at the bar end: a long
                negative bar used to push its label back over the category name. */}
            <text x={LABEL_W + plotW + 10} y={y + BAR_H - 1} className="bars-value">
              {`${d.value > 0 ? "+" : ""}${d.value.toFixed(2)}${unit}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
