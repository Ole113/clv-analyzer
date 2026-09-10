"use client";

import { useState, useTransition } from "react";
import { useToast } from "./toast";

export interface BookRow {
  bookKey: string;
  label: string;
}

/**
 * Book display order (used in the "When you took it" / "At market close" tables) and, optionally,
 * per-book weights for the closing average -- edited together since both live on the same row per
 * book. Reordering only ever swaps two adjacent rows, so up/down buttons cover it without needing
 * drag-and-drop.
 */
export function BookSettingsForm({
  initialOrder,
  books,
  initialWeights,
  initialUseWeighted,
  initialUseLiquidity,
  saveAction,
}: {
  initialOrder: string[];
  books: BookRow[];
  initialWeights: Record<string, number>;
  initialUseWeighted: boolean;
  initialUseLiquidity: boolean;
  saveAction: (
    order: string[],
    weights: Record<string, number>,
    useWeightedAverage: boolean,
    useLiquidityWeighting: boolean
  ) => Promise<void>;
}) {
  const { push } = useToast();
  const labelOf = (key: string) => books.find((b) => b.bookKey === key)?.label ?? key;

  const [order, setOrder] = useState<string[]>(initialOrder);
  const [weights, setWeights] = useState<Record<string, number>>(initialWeights);
  const [useWeighted, setUseWeighted] = useState(initialUseWeighted);
  const [useLiquidity, setUseLiquidity] = useState(initialUseLiquidity);
  const [pending, startTransition] = useTransition();

  const move = (index: number, dir: -1 | 1) => {
    const next = [...order];
    const swap = index + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[index], next[swap]] = [next[swap], next[index]];
    setOrder(next);
  };

  const save = () =>
    startTransition(async () => {
      try {
        await saveAction(order, weights, useWeighted, useLiquidity);
        push("success", "Book settings saved");
      } catch (error) {
        push("error", "Could not save book settings", error instanceof Error ? error.message : null);
      }
    });

  return (
    <div>
      <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={useWeighted}
          onChange={(e) => setUseWeighted(e.target.checked)}
        />
        Use a weighted average for the closing line, instead of a plain mean
      </label>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        A book left at its default weight (1) is still included — it is just averaged in on equal
        footing with every other unweighted book, rather than counted extra.
      </p>

      <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={useLiquidity}
          onChange={(e) => setUseLiquidity(e.target.checked)}
        />
        Also weight by the money resting behind each closing quote
      </label>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        Only the odds screen reports depth, and most sportsbooks publish none — those keep the
        default weight rather than being dropped. A weight you set by hand above always wins over
        the automatic one. Affects closing reads taken from here on, not verdicts already recorded.
      </p>

      <table className="math-table">
        <tbody>
          {order.map((key, i) => (
            <tr key={key}>
              <td style={{ width: 1, whiteSpace: "nowrap" }}>
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                  ↑
                </button>{" "}
                <button
                  type="button"
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                  title="Move down"
                >
                  ↓
                </button>
              </td>
              <td>{labelOf(key)}</td>
              <td className="num" style={{ width: 1, whiteSpace: "nowrap" }}>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  disabled={!useWeighted}
                  value={weights[key] ?? 1}
                  style={{ width: 70 }}
                  onChange={(e) =>
                    setWeights((w) => ({ ...w, [key]: Math.max(0, Number(e.target.value) || 0) }))
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 14 }}>
        <span className="action-btn-wrap">
          <button type="button" className="primary" disabled={pending} onClick={save}>
            {pending ? "Saving..." : "Save book settings"}
          </button>
        </span>
      </div>
    </div>
  );
}
