import type { MarketType, ParsedRow, PickSide } from "./types";

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
  marketType: MarketType;
  /** Player props only. */
  player: string | null;
  /** Spreads only: the team the signed line belongs to. */
  subjectTeam: string | null;
  statMarket: string;
  side: PickSide | null;
  /** "Team vs Team", used to keep game markets from matching the wrong fixture. */
  matchup: string | null;
  externalPropId: string | null;
}

/** Teams are written inconsistently across boards ("LA Rams" / "Los Angeles Rams"). */
function teamsOverlap(a: string | null, b: string | null): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return true; // nothing to contradict
  return x === y || x.includes(y) || y.includes(x);
}

function statScore(rowStat: string | null, wantStat: string): number | null {
  const stat = normalizeName(rowStat);
  if (stat === wantStat) return 10;
  if (stat.includes(wantStat) || wantStat.includes(stat)) return 5;
  return null;
}

/**
 * Finds the same bet in a freshly parsed board at closing time.
 *
 * Scored rather than exact-matched because the line (and therefore the site's row id) will have
 * moved -- that movement is the entire point of the tool. The identifying fields must always
 * agree: a wrong match would silently produce a bogus verdict, which is worse than reporting no
 * match at all.
 *
 * What identifies a bet depends on the market. A player prop is the player plus the stat plus the
 * side. A game total has no player, so it is the market plus the side within the same fixture. A
 * spread is the market plus the team the line belongs to.
 */
export function findMatchingRow(rows: ParsedRow[], target: MatchTarget): ParsedRow | null {
  const wantStat = normalizeName(target.statMarket);
  const wantIdPrefix = stripTrailingLine(target.externalPropId);

  let best: { row: ParsedRow; score: number } | null = null;

  for (const row of rows) {
    if (row.marketType !== target.marketType) continue;

    let score = 10;

    if (target.marketType === "PLAYER_PROP") {
      if (!row.player || !row.side) continue;
      if (row.side !== target.side) continue;
      if (normalizeName(row.player) !== normalizeName(target.player)) continue;
      const s = statScore(row.statMarket, wantStat);
      if (s === null) continue; // same player, different market -- not our prop
      score += s;
    } else {
      // Game markets: the fixture has to agree, or "Over 14.5" would match another game entirely.
      if (!teamsOverlap(row.matchup, target.matchup)) continue;
      const s = statScore(row.statMarket, wantStat);
      if (s === null) continue;
      score += s;

      if (target.marketType === "SPREAD") {
        if (!row.subjectTeam || !teamsOverlap(row.subjectTeam, target.subjectTeam)) continue;
        score += 5;
      } else {
        if (!row.side || row.side !== target.side) continue;
        score += 5;
      }
    }

    const rowIdPrefix = stripTrailingLine(row.externalPropId);
    if (wantIdPrefix && rowIdPrefix && rowIdPrefix === wantIdPrefix) score += 20;

    if (!best || score > best.score) best = { row, score };
  }

  return best?.row ?? null;
}

/**
 * Deterministic identity for a captured pick, computed identically in the extension and on the
 * server so the board can ask "is this row already tracked?" without the extension knowing
 * anything about the database.
 *
 * Deliberately excludes the line: the same pick keeps its key as the market moves, which is what
 * lets the closing capture find it again.
 *
 * The subject is the player for a player prop and the team for a spread; a game total has no
 * subject, so its market label plus side carries the identity. marketType is part of the key so a
 * total and a spread on the same fixture can never collide.
 */
export function buildMatchKey(input: {
  site: string;
  fantasyBook: string;
  sport: string | null;
  marketType: MarketType;
  player: string | null;
  subjectTeam: string | null;
  statMarket: string | null;
  side: string | null;
  gameStartTime: Date | string | null;
}): string {
  const start =
    input.gameStartTime === null
      ? "no-time"
      : (typeof input.gameStartTime === "string"
          ? new Date(input.gameStartTime)
          : input.gameStartTime
        ).toISOString().slice(0, 16);
  return [
    input.site,
    input.fantasyBook.toLowerCase(),
    normalizeName(input.sport),
    input.marketType,
    normalizeName(input.player ?? input.subjectTeam),
    normalizeName(input.statMarket),
    input.side ?? "-",
    start,
  ].join("|");
}

/** The match key for a freshly parsed row, so the extension can key its checkboxes by it. */
export function matchKeyForRow(
  site: string,
  fantasyBook: string,
  row: ParsedRow
): string {
  return buildMatchKey({
    site,
    fantasyBook,
    sport: row.sport,
    marketType: row.marketType,
    player: row.player,
    subjectTeam: row.subjectTeam,
    statMarket: row.statMarket,
    side: row.side,
    gameStartTime: row.gameStartTimeIso,
  });
}
