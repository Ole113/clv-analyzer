import type { ParsedRow, PickSide } from "./types";

/** Prop matching, shared so the extension and the server agree on what "the same pick" means. */

export function normalizeName(input: string | null | undefined): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strips the trailing line off a site row id, which moves between capture and close. */
export function stripTrailingLine(externalPropId: string | null | undefined): string | null {
  if (!externalPropId) return null;
  return normalizeName(externalPropId.replace(/[_\s]-?\d+(\.\d+)?\s*$/, ""));
}

export interface MatchTarget {
  player: string;
  statMarket: string;
  side: PickSide;
  externalPropId: string | null;
}

/**
 * Finds the same prop in a freshly parsed board at closing time.
 *
 * Scored rather than exact-matched because the line (and therefore the site's row id) will have
 * moved, and stat labels can pick up suffixes. Player and side must always agree -- a wrong match
 * would silently produce a bogus verdict, which is worse than reporting no match at all.
 */
export function findMatchingRow(rows: ParsedRow[], target: MatchTarget): ParsedRow | null {
  const wantPlayer = normalizeName(target.player);
  const wantStat = normalizeName(target.statMarket);
  const wantIdPrefix = stripTrailingLine(target.externalPropId);

  let best: { row: ParsedRow; score: number } | null = null;

  for (const row of rows) {
    if (!row.player || !row.side) continue;
    if (row.side !== target.side) continue;

    if (normalizeName(row.player) !== wantPlayer) continue;

    const rowStat = normalizeName(row.statMarket);
    let score = 10;
    if (rowStat === wantStat) score += 10;
    else if (rowStat.includes(wantStat) || wantStat.includes(rowStat)) score += 5;
    else continue; // same player, different market -- not our prop

    const rowIdPrefix = stripTrailingLine(row.externalPropId);
    if (wantIdPrefix && rowIdPrefix && rowIdPrefix === wantIdPrefix) score += 20;

    if (!best || score > best.score) best = { row, score };
  }

  return best?.row ?? null;
}
