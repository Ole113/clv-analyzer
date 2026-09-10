"use client";

import { useState, useTransition } from "react";
import { useToast } from "./toast";

/**
 * Loads N fake picks tagged as test data, so the dashboard, analysis page and delete flows can be
 * exercised without waiting on real captures. Generation needs no confirmation -- it only adds
 * rows -- but deleting them (PurgeForm's "Only test data" checkbox, or its "Delete all test data"
 * button) does.
 */
export function TestDataForm({
  max,
  generateAction,
}: {
  max: number;
  generateAction: (amount: number) => Promise<number>;
}) {
  const { push } = useToast();
  const [amount, setAmount] = useState(20);
  const [pending, startTransition] = useTransition();

  return (
    <div className="purge">
      <span className="muted">Load</span>
      <input
        type="number"
        min={1}
        max={max}
        value={amount}
        onChange={(e) => setAmount(Math.max(1, Math.min(max, Number(e.target.value) || 1)))}
      />
      <span className="muted">test data picks (a mix of open and closed, for trying things out)</span>
      <span className="action-btn-wrap">
        <button
          type="button"
          className="primary"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              try {
                const n = await generateAction(amount);
                push("success", `Loaded ${n} test data pick${n === 1 ? "" : "s"}`);
              } catch (error) {
                push(
                  "error",
                  "Could not load test data",
                  error instanceof Error ? error.message : null
                );
              }
            })
          }
        >
          {pending ? "Loading..." : "Load test data"}
        </button>
      </span>
    </div>
  );
}
