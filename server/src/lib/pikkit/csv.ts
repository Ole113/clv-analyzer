/**
 * A minimal RFC 4180 reader, for the Pikkit export and nothing else.
 *
 * Splitting on commas is not enough here and the failure is silent rather than loud: `bet_info`
 * carries team and player names, and a single "Hits, Runs + RBIs" or "St. Louis, MO" shifts every
 * later column of that one row by one, so a handful of bets quietly acquire the wrong sportsbook
 * and stake while the other several hundred parse fine.
 *
 * Hand-rolled rather than a dependency for the same reason the icons are (see the note in
 * `src/app/layout.tsx`): the whole grammar this needs is quoting, doubled quotes, and newlines
 * inside quotes.
 */

/** Split raw CSV text into rows of raw cells. Blank lines are dropped. */
export function parseCsvRows(text: string): string[][] {
  // A UTF-8 BOM would otherwise ride along on the first header name, so "bet_id" never matches.
  const input = text.replace(/^﻿/, "");

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    // A trailing newline produces one final empty row, which is not a record.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (quoted) {
      if (ch !== '"') {
        cell += ch;
      } else if (input[i + 1] === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        cell += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === ",") {
      endCell();
    } else if (ch === "\n") {
      endRow();
    } else if (ch === "\r") {
      // CRLF: the \n that follows does the work. A lone \r is treated as a line break too.
      if (input[i + 1] !== "\n") endRow();
    } else {
      cell += ch;
    }
  }

  // A file whose last line has no terminator still has a record in flight.
  if (cell !== "" || row.length > 0) endRow();

  return rows;
}

/**
 * Read CSV text as records keyed by the header row.
 *
 * Short rows yield "" for the missing columns rather than undefined, so every caller can treat a
 * missing cell and an empty cell the same way -- which is what the export itself does, since an
 * absent closing line arrives as an empty string.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((name, i) => {
      record[name] = cells[i] ?? "";
    });
    return record;
  });
}
