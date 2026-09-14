import { SortableTableClient } from "./sortable-table-client";

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
 * No "use client" here on purpose: every caller is a Server Component (the /analysis views) and
 * every column's `render`/`sortValue` is a plain closure over its own data. Those closures cannot
 * cross into `SortableTableClient` -- a Client Component's props must be serializable, and a bare
 * function is not -- so this module runs them itself, on the server, and hands the *result*
 * (already-rendered cells, plain sort keys) across the boundary instead. Only that inner component
 * carries "use client"; this one is free to hold onto whatever functions its caller gives it.
 */

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
  const colDefs = columns.map((c) => ({
    key: c.key,
    label: c.label,
    numeric: c.numeric,
    sortable: !!c.sortValue,
  }));

  const rowData = rows.map((row) => ({
    key: rowKey(row),
    className: rowClassName?.(row),
    cells: Object.fromEntries(columns.map((c) => [c.key, c.render(row)] as const)),
    sortValues: Object.fromEntries(
      columns.map((c) => [c.key, c.sortValue ? c.sortValue(row) : null] as const)
    ),
  }));

  return <SortableTableClient columns={colDefs} rows={rowData} />;
}
