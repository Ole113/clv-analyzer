"use client";

import { useMemo, useState } from "react";

/**
 * A `<table>` whose headers sort the rows client-side, for the small breakdown tables tucked behind
 * every "Show the numbers" disclosure on /analysis.
 *
 * Deliberately not the same machinery as `bets-table.tsx`'s `SortableTh`: that one keeps sort state
 * in the URL because it is the one real table on its page and surviving a back-navigation matters.
 * These are a dozen tiny, independent tables on one page, each already collapsed by default --
 * component-local state is the right amount of memory for something that resets the moment the
 * `<details>` closes, and it means one table's sort can never collide with another's in the query
 * string.
 *
 * Same interaction and CSS classes as `bets-table.tsx` (`.sortable`, `.sort-indicator`) so a header
 * click behaves identically everywhere in the app: first click ascending, second descending, third
 * back to the data's own order.
 */

export type SortDir = "asc" | "desc";

export interface SortableColumn<T> {
  key: string;
  label: React.ReactNode;
  /** Right-aligns the column, matching every other numeric column in the app. */
  numeric?: boolean;
  /**
   * The value a click on this header sorts by. Omitted for a column with nothing sortable to say
   * (there is at most one of those per table here) -- its header renders without the sortable
   * affordance rather than sorting on a value that doesn't exist.
   */
  sortValue?: (row: T) => string | number | null;
  render: (row: T) => React.ReactNode;
}

/** Nulls (and empty strings) sort last regardless of direction -- "no value yet" is not
 *  meaningfully high or low. Mirrors `compareBets` in `bets-table.tsx`. */
function compare(a: string | number | null, b: string | number | null, dir: SortDir): number {
  const aEmpty = a === null || a === "";
  const bEmpty = b === null || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const cmp = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return dir === "asc" ? cmp : -cmp;
}

export function SortableTable<T>({
  columns,
  rows,
  rowKey,
  rowClassName,
}: {
  columns: SortableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
}) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);

  const onSort = (key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null; // third click: back to the data's own order
    });
  };

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    return [...rows].sort((a, b) => compare(sv(a), sv(b), sort.dir));
  }, [rows, sort, columns]);

  return (
    <table>
      <thead>
        <tr>
          {columns.map((c) => {
            const active = sort?.key === c.key;
            const sortable = !!c.sortValue;
            return (
              <th
                key={c.key}
                className={[c.numeric ? "num" : null, sortable ? "sortable" : null].filter(Boolean).join(" ") || undefined}
                role={sortable ? "button" : undefined}
                tabIndex={sortable ? 0 : undefined}
                onClick={sortable ? () => onSort(c.key) : undefined}
                onKeyDown={
                  sortable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSort(c.key);
                        }
                      }
                    : undefined
                }
              >
                {c.label}
                {active && (
                  <span className="sort-indicator">{sort!.dir === "asc" ? " ▲" : " ▼"}</span>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={rowKey(row)} className={rowClassName?.(row)}>
            {columns.map((c) => (
              <td key={c.key} className={c.numeric ? "num" : undefined}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
