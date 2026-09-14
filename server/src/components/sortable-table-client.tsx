"use client";

import { useMemo, useState } from "react";

/**
 * The interactive half of `sortable-table.tsx`, split into its own "use client" module for one
 * reason: a Client Component's props must be serializable, and a column's `render`/`sortValue`
 * are plain closures defined in the (Server Component) analysis pages -- crossing the boundary
 * with a bare function throws "Functions cannot be passed directly to Client Components" at
 * render time, not at build time, since /analysis is dynamic and nothing exercises it during
 * `next build`.
 *
 * So this component never sees a function. `sortable-table.tsx` (no "use client", so it runs on
 * the server and may hold onto whatever closures it likes) calls every column's `render` and
 * `sortValue` itself and hands this component only the result: plain sort keys (string | number |
 * null) and already-rendered `ReactNode` cells. Both cross the RSC boundary fine -- only a raw
 * function does not.
 */

export type SortDir = "asc" | "desc";

export interface SortableColumnDef {
  key: string;
  label: React.ReactNode;
  /** Right-aligns the column, matching every other numeric column in the app. */
  numeric?: boolean;
  /** False for the rare column with nothing sortable to say -- its header renders without the
   *  sortable affordance rather than sorting on a value that doesn't exist. */
  sortable: boolean;
}

export interface SortableRowData {
  key: string;
  className?: string;
  cells: Record<string, React.ReactNode>;
  sortValues: Record<string, string | number | null>;
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

export function SortableTableClient({
  columns,
  rows,
}: {
  columns: SortableColumnDef[];
  rows: SortableRowData[];
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
    return [...rows].sort((a, b) =>
      compare(a.sortValues[sort.key] ?? null, b.sortValues[sort.key] ?? null, sort.dir)
    );
  }, [rows, sort]);

  return (
    <table>
      <thead>
        <tr>
          {columns.map((c) => {
            const active = sort?.key === c.key;
            return (
              <th
                key={c.key}
                className={[c.numeric ? "num" : null, c.sortable ? "sortable" : null].filter(Boolean).join(" ") || undefined}
                role={c.sortable ? "button" : undefined}
                tabIndex={c.sortable ? 0 : undefined}
                onClick={c.sortable ? () => onSort(c.key) : undefined}
                onKeyDown={
                  c.sortable
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
          <tr key={row.key} className={row.className}>
            {columns.map((c) => (
              <td key={c.key} className={c.numeric ? "num" : undefined}>
                {row.cells[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
