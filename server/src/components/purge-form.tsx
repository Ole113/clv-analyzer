"use client";

import { useState, useTransition } from "react";
import { Modal } from "./modal";
import { useToast } from "./toast";

/** Upper bound per unit, so "365 years" is not offerable once the unit changes. */
const UNIT_MAX: Record<string, number> = { days: 365, weeks: 260, months: 60, years: 20 };

/**
 * Deleting picks is irreversible and there is no undo, so it takes two deliberate steps: the
 * first press only asks the server how many rows match and shows that number, and only the second
 * press -- behind a dialog naming the count -- actually deletes.
 */
export function PurgeForm({
  countAction,
  purgeAction,
  demoOnly,
  demoCount,
  purgeDemoAction,
}: {
  countAction?: (amount: number, unit: string, onlyTestData: boolean) => Promise<number>;
  purgeAction?: (amount: number, unit: string, onlyTestData: boolean) => Promise<number>;
  demoOnly?: boolean;
  demoCount?: number;
  purgeDemoAction?: () => Promise<number>;
}) {
  const { push } = useToast();
  const [amount, setAmount] = useState(1);
  const [unit, setUnit] = useState("days");
  const [onlyTestData, setOnlyTestData] = useState(false);
  const [staged, setStaged] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  if (demoOnly) {
    return (
      <div className="purge">
        <span className="muted">{demoCount} test data pick(s).</span>
        <span className="action-btn-wrap">
          <button
            type="button"
            className="danger"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            {pending ? "Deleting..." : "Delete all test data"}
          </button>
        </span>
        <Modal
          open={confirming}
          title="Delete all test data?"
          body={`All ${demoCount} rows marked as test data will be removed. Real captured picks are untouched.`}
          confirmLabel="Delete them"
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            startTransition(async () => {
              try {
                const n = await purgeDemoAction!();
                push("success", `Deleted ${n} test data pick${n === 1 ? "" : "s"}`);
              } catch (error) {
                push(
                  "error",
                  "Could not delete the test data",
                  error instanceof Error ? error.message : null
                );
              }
            });
          }}
        />
      </div>
    );
  }

  const max = UNIT_MAX[unit] ?? 365;
  const reset = () => {
    setStaged(null);
  };

  return (
    <div className="purge">
      <span className="muted">Clear picks captured in the last</span>
      <input
        type="number"
        min={1}
        max={max}
        value={amount}
        onChange={(e) => {
          setAmount(Math.max(1, Math.min(max, Number(e.target.value))));
          reset();
        }}
      />
      <select
        value={unit}
        onChange={(e) => {
          const next = e.target.value;
          setUnit(next);
          // Switching days -> years must not leave a stale 365 in the box.
          setAmount((a) => Math.min(a, UNIT_MAX[next] ?? 365));
          reset();
        }}
      >
        <option value="days">days</option>
        <option value="weeks">weeks</option>
        <option value="months">months</option>
        <option value="years">years</option>
      </select>

      <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={onlyTestData}
          onChange={(e) => {
            setOnlyTestData(e.target.checked);
            reset();
          }}
        />
        Only test data
      </label>

      {/* At a count of zero there is nothing to confirm or cancel, so neither button is offered --
          only the finding, plus the chance to check a different window. */}
      {staged === null || staged === 0 ? (
        <>
          {staged === 0 && (
            <span className="muted">
              No {onlyTestData ? "test data " : ""}picks were captured in that window — nothing to
              delete.
            </span>
          )}
          <span className="action-btn-wrap">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    setStaged(await countAction!(amount, unit, onlyTestData));
                  } catch (error) {
                    push(
                      "error",
                      "Could not check what this deletes",
                      error instanceof Error ? error.message : null
                    );
                  }
                })
              }
            >
              {pending ? "Checking..." : staged === 0 ? "Check again" : "Check what this deletes"}
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="warn-note">
            {staged} pick{staged === 1 ? "" : "s"} would be deleted
          </span>
          <span className="action-btn-wrap">
            <button
              type="button"
              className="danger"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              {pending ? "Deleting..." : `Delete ${staged}`}
            </button>
          </span>
          <button type="button" onClick={reset} disabled={pending}>
            Cancel
          </button>
        </>
      )}

      <Modal
        open={confirming}
        title={`Delete ${staged} pick${staged === 1 ? "" : "s"}?`}
        body={
          <>
            Every {onlyTestData ? "test data " : ""}pick captured in the last {amount} {unit}, and
            both of its snapshots, will be permanently removed.{" "}
            <strong>This cannot be undone.</strong>
          </>
        }
        confirmLabel={`Delete ${staged} permanently`}
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          startTransition(async () => {
            try {
              const n = await purgeAction!(amount, unit, onlyTestData);
              setStaged(null);
              push("success", `Deleted ${n} pick${n === 1 ? "" : "s"}`);
            } catch (error) {
              push(
                "error",
                "Could not delete those picks",
                error instanceof Error ? error.message : null
              );
            }
          });
        }}
      />
    </div>
  );
}
