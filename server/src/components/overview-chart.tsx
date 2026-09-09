"use client";

import { useState } from "react";
import type { SeriesPoint } from "@/lib/queries";

type MetricKey = "beatRate" | "hitRate" | "avgEv" | "avgEdge" | "cumulativeEdge" | "picks";

const METRICS: Record<
  MetricKey,
  {
    label: string;
    unit: string;
    digits: number;
    scale: number;
    zeroLine: boolean;
    /** Hard bounds the axis may never exceed -- a rate cannot pass 100%. */
    clamp?: [number | null, number | null];
  }
> = {
  beatRate: { label: "Beat CLV %", unit: "%", digits: 1, scale: 100, zeroLine: false, clamp: [0, 100] },
  hitRate: { label: "Hit rate", unit: "%", digits: 1, scale: 100, zeroLine: false, clamp: [0, 100] },
  avgEv: { label: "Avg EV%", unit: "%", digits: 2, scale: 1, zeroLine: true },
  avgEdge: { label: "Avg edge", unit: "", digits: 2, scale: 1, zeroLine: true },
  cumulativeEdge: { label: "Cumulative edge", unit: "", digits: 1, scale: 1, zeroLine: true },
  picks: { label: "Picks captured", unit: "", digits: 0, scale: 1, zeroLine: false, clamp: [0, null] },
};

const W = 720;
const H = 220;
const PAD = { top: 14, right: 16, bottom: 26, left: 44 };

/**
 * One metric over time, chosen by the reader.
 *
 * A line is the right form for change-over-time, and only one metric is ever drawn: two measures
 * on different scales would need two y-axes, which is never correct. Days with no settled picks
 * leave a gap rather than being interpolated through.
 */
export function OverviewChart({ series, initial = "beatRate" }: { series: SeriesPoint[]; initial?: MetricKey }) {
  const [metric, setMetric] = useState<MetricKey>(initial);
  const spec = METRICS[metric];

  const points = series
    .map((p) => ({ date: p.date, raw: p[metric] as number | null }))
    .map((p) => ({ ...p, value: p.raw === null ? null : p.raw * spec.scale }));

  const present = points.filter((p): p is { date: string; raw: number; value: number } => p.value !== null);

  if (present.length < 2) {
    return (
      <div className="chart-card">
        <MetricTabs metric={metric} setMetric={setMetric} />
        <p className="muted" style={{ marginBottom: 0 }}>
          Not enough days with data yet to plot {spec.label.toLowerCase()} — at least two are needed.
        </p>
      </div>
    );
  }

  const values = present.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (spec.zeroLine) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const padY = (max - min) * 0.12;
  min -= padY;
  max += padY;
  if (spec.clamp) {
    const [lo, hi] = spec.clamp;
    if (lo !== null) min = Math.max(min, lo);
    if (hi !== null) max = Math.min(max, hi);
  }

  const x = (i: number) => PAD.left + (i / Math.max(points.length - 1, 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);

  // Break the path wherever a day has no value, so gaps are not silently bridged.
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));

  const zeroY = spec.zeroLine && min <= 0 && max >= 0 ? y(0) : null;
  const ticks = [max, (max + min) / 2, min];
  const labelEvery = Math.ceil(points.length / 6);

  return (
    <div className="chart-card">
      <MetricTabs metric={metric} setMetric={setMetric} />
      <svg className="ts" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${spec.label} over time`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} y1={y(t)} x2={W - PAD.right} y2={y(t)} className="ts-grid" />
            <text x={PAD.left - 8} y={y(t) + 3} className="ts-axis" textAnchor="end">
              {t.toFixed(spec.digits)}
              {spec.unit}
            </text>
          </g>
        ))}
        {zeroY !== null && (
          <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY} className="ts-zero" />
        )}

        {segments.map((d, i) => (
          <path key={i} d={d} className="ts-line" />
        ))}

        {present.map((p) => {
          const i = points.findIndex((q) => q.date === p.date);
          return (
            <circle key={p.date} cx={x(i)} cy={y(p.value)} r={3.5} className="ts-dot">
              <title>{`${p.date}: ${p.value.toFixed(spec.digits)}${spec.unit}`}</title>
            </circle>
          );
        })}

        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <text key={p.date} x={x(i)} y={H - 8} className="ts-axis" textAnchor="middle">
              {p.date.slice(5)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

function MetricTabs({
  metric,
  setMetric,
}: {
  metric: MetricKey;
  setMetric: (m: MetricKey) => void;
}) {
  return (
    <div className="metric-tabs">
      {(Object.keys(METRICS) as MetricKey[]).map((key) => (
        <button
          key={key}
          type="button"
          className={key === metric ? "active" : ""}
          onClick={() => setMetric(key)}
        >
          {METRICS[key].label}
        </button>
      ))}
    </div>
  );
}
