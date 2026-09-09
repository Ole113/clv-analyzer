/**
 * Signed numbers carry their own verdict, so they are coloured: blue-green when the movement was
 * in your favour, red when it went against you, muted at exactly flat. Colour is never the only
 * cue -- the sign and the number are always shown too.
 */
export function Signed({
  value,
  unit = "",
  digits = 2,
  invert,
}: {
  value: number | null;
  unit?: string;
  digits?: number;
  /** For metrics where lower is better. */
  invert?: boolean;
}) {
  if (value === null) return <span className="muted">--</span>;
  const good = invert ? value < 0 : value > 0;
  const bad = invert ? value > 0 : value < 0;
  const cls = good ? "good" : bad ? "bad" : "flat";
  return (
    <span className={`val ${cls}`}>
      {value > 0 ? "+" : ""}
      {value.toFixed(digits)}
      {unit}
    </span>
  );
}

/** A rate where `threshold` (default break-even 50%) separates good from bad. */
export function Rate({
  value,
  threshold = 0.5,
  digits = 1,
}: {
  value: number | null;
  threshold?: number;
  digits?: number;
}) {
  if (value === null) return <span className="muted">--</span>;
  const cls = value > threshold ? "good" : value < threshold ? "bad" : "flat";
  return <span className={`val ${cls}`}>{(value * 100).toFixed(digits)}%</span>;
}

/** A count that is only ever bad when non-zero (failures, stuck picks). */
export function ProblemCount({ value }: { value: number }) {
  return <span className={`val ${value > 0 ? "warn" : "flat"}`}>{value}</span>;
}
