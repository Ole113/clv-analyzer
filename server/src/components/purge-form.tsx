"use client";

import { useState, useTransition } from "react";

/** Upper bound per unit, so "365 years" is not offerable once the unit changes. */
const UNIT_MAX: Record<string, number> = { days: 365, weeks: 260, months: 60, years: 20 };

/**
 * Deleting picks is irreversible and there is no undo, so it takes two deliberate steps: the
 * first press only asks the server how many rows match and shows that number, and only the second
 * press -- after a native confirm naming the count -- actually deletes.
 */
export function PurgeForm({
  countAction,
  purgeAction,
  demoOnly,
  demoCount,
  purgeDemoAction,
}: {
  countAction?: (amount: number, unit: string) => Promise<number>;
  purgeAction?: (amount: number, unit: string) => Promise<number>;
  demoOnly?: boolean;
  demoCount?: number;
  purgeDemoAction?: () => Promise<number>;
}) {
  const [amount, setAmount] = useState(1);
  const [unit, setUnit] = useState("days");
  const [staged, setStaged] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (demoOnly) {
    return (
      <div className="purge">
        <span className="muted">{demoCount} demo pick(s) from the seed script.</span>
        <button
          type="button"
          className="danger"
          disabled={pending}
          onClick={() => {
            if (!window.confirm(`Delete all ${demoCount} demo picks?`)) return;
            startTransition(async () => {
              const n = await purgeDemoAction!();
              setResult(`Deleted ${n} demo pick(s).`);
            });
          }}
        >
          Delete demo picks
        </button>
        {result && <span className="ok-note">{result}</span>}
      </div>
    );
  }

  return (
    <div className="purge">
      <span className="muted">Clear picks captured in the last</span>
      <input
        type="number"
        min={1}
        max={UNIT_MAX[unit] ?? 365}
        value={amount}
        onChange={(e) => {
          setAmount(Math.max(1, Math.min(UNIT_MAX[unit] ?? 365, Number(e.target.value))));
          setStaged(null);
          setResult(null);
        }}
      />
      <select
        value={unit}
        onChange={(e) => {
          const next = e.target.value;
          setUnit(next);
          // Switching days -> years must not leave a stale 365 in the box.
          setAmount((a) => Math.min(a, UNIT_MAX[next] ?? 365));
          setStaged(null);
          setResult(null);
        }}
      >
        <option value="days">days</option>
        <option value="weeks">weeks</option>
        <option value="months">months</option>
        <option value="years">years</option>
      </select>

      {staged === null ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setResult(null);
              setStaged(await countAction!(amount, unit));
            })
          }
        >
          {pending ? "Checking..." : "Check what this deletes"}
        </button>
      ) : (
        <>
          <span className={staged > 0 ? "warn-note" : "muted"}>
            {staged} pick{staged === 1 ? "" : "s"} would be deleted
          </span>
          <button
            type="button"
            className="danger"
            disabled={pending || staged === 0}
            onClick={() => {
              if (
                !window.confirm(
                  `Permanently delete ${staged} pick(s) captured in the last ${amount} ${unit}?`
                )
              )
                return;
              if (!window.confirm("This cannot be undone. Delete them for good?")) return;
              startTransition(async () => {
                const n = await purgeAction!(amount, unit);
                setStaged(null);
                setResult(`Deleted ${n} pick(s).`);
              });
            }}
          >
            {pending ? "Deleting..." : `Delete ${staged}`}
          </button>
          <button type="button" onClick={() => setStaged(null)} disabled={pending}>
            Cancel
          </button>
        </>
      )}
      {result && <span className="ok-note">{result}</span>}
    </div>
  );
}
