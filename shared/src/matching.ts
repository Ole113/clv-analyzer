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

/** Splits "Boston College vs. Rutgers" / "Rutgers @ Boston College" into its two sides. */
function matchupSides(matchup: string | null): string[] {
  if (!matchup) return [];
  return matchup
    .split(/\s+(?:vs\.?|v\.?|@|at)\s+/i)
    .map((s) => normalizeName(s))
    .filter(Boolean);
}

/**
 * Whether two fixture strings name the same game, regardless of which team is written first.
 *
 * Home/away order is not agreed between sources: the same game reads "Rutgers vs Boston College" on
 * OddsJam and "Boston College vs. Rutgers" on PropProfessor -- different separator *and* reversed
 * order. Comparing the raw strings, as a plain substring test does, calls that a different game.
 */
function matchupsOverlap(a: string | null, b: string | null): boolean {
  const left = matchupSides(a);
  const right = matchupSides(b);
  if (left.length === 0 || right.length === 0) return true; // nothing to contradict
  // Every side of the shorter list must find a partner in the other, in either order.
  return left.every((l) => right.some((r) => l === r || l.includes(r) || r.includes(l)));
}

/**
 * How well two player names agree, or null when they cannot be the same person.
 *
 * Exact agreement is the normal case and the only one the optimizer ever needed. Surname-only
 * agreement has to be allowed because the odds screen writes tennis players as bare surnames
 * ("Tiafoe", "Shelton") while picks are captured with full names ("Alexander Zverev") -- an exact
 * test would fail to price every tennis pick ever taken.
 *
 * It scores lower than an exact match, which matters: two players sharing a surname in the same
 * market both score the same, and the caller rejects ties rather than guessing between them.
 */
function playerScore(rowPlayer: string | null, targetPlayer: string | null): number | null {
  const row = normalizeName(rowPlayer);
  const want = normalizeName(targetPlayer);
  if (!row || !want) return null;
  if (row === want) return 10;

  const rowTokens = row.split(" ");
  const wantTokens = want.split(" ");
  const rowLast = rowTokens[rowTokens.length - 1];
  const wantLast = wantTokens[wantTokens.length - 1];
  if (rowLast !== wantLast) return null;

  // Only when one side genuinely is a bare surname. "Alex Smith" vs "John Smith" share a last name
  // and must not match; "Smith" vs "Alex Smith" is the abbreviation the screen actually uses.
  if (rowTokens.length === 1 || wantTokens.length === 1) return 6;

  return rowTokens[0][0] === wantTokens[0][0] ? 6 : null;
}

/**
 * Below this a match is not trustworthy enough to record a verdict from.
 *
 * A guard rail rather than the main protection -- the hard filters above already reject anything
 * that disagrees on identity, so nothing currently scores under it. It exists so that a later
 * loosening of those filters fails closed instead of silently admitting weak matches.
 */
const MIN_MATCH_SCORE = 20;

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
  let runnerUp: { row: ParsedRow; score: number } | null = null;

  for (const row of rows) {
    if (row.marketType !== target.marketType) continue;

    let score = 10;

    if (target.marketType === "PLAYER_PROP") {
      if (!row.player || !row.side) continue;
      if (row.side !== target.side) continue;
      const p = playerScore(row.player, target.player);
      if (p === null) continue;
      score += p;
      const s = statScore(row.statMarket, wantStat);
      if (s === null) continue; // same player, different market -- not our prop
      score += s;
    } else {
      // Game markets: the fixture has to agree, or "Over 14.5" would match another game entirely.
      if (!matchupsOverlap(row.matchup, target.matchup)) continue;
      const s = statScore(row.statMarket, wantStat);
      if (s === null) continue;
      score += s;

      if (target.marketType === "SPREAD" || target.marketType === "MONEYLINE") {
        // Moneylines have no side either -- like a spread, the team carries the identity.
        if (!row.subjectTeam || !teamsOverlap(row.subjectTeam, target.subjectTeam)) continue;
        score += 5;
      } else {
        if (!row.side || row.side !== target.side) continue;
        score += 5;
      }
    }

    const rowIdPrefix = stripTrailingLine(row.externalPropId);
    if (wantIdPrefix && rowIdPrefix && rowIdPrefix === wantIdPrefix) score += 20;

    if (!best || score > best.score) {
      runnerUp = best;
      best = { row, score };
    } else if (!runnerUp || score > runnerUp.score) {
      runnerUp = { row, score };
    }
  }

  if (!best || best.score < MIN_MATCH_SCORE) return null;

  // A tie between two rows that name *different people or teams* is unresolvable, and picking the
  // first one silently produces a plausible verdict for the wrong pick -- worse than reporting no
  // match, because nothing downstream would ever flag it. This became reachable when the candidate
  // pool grew from "a handful of props that still have edge" to "every player in the market".
  //
  // Ties between rows of the same identity are left alone: those are one pick offered at several
  // lines (Alt boards), where the previous behaviour of taking the top scorer is still correct.
  if (runnerUp && runnerUp.score === best.score && !sameSubject(best.row, runnerUp.row)) {
    return null;
  }

  return best.row;
}

/** Whether two candidate rows are about the same player or team, ignoring the line. */
function sameSubject(a: ParsedRow, b: ParsedRow): boolean {
  return (
    normalizeName(a.player) === normalizeName(b.player) &&
    normalizeName(a.subjectTeam) === normalizeName(b.subjectTeam)
  );
}

/**
 * Deterministic identity for a captured pick, computed identically in the extension and on the
 * server so the board can ask "is this row already tracked?" without the extension knowing
 * anything about the database.
 *
 * Includes the taken line. It used to be excluded on the theory that the closing capture needed a
 * line-stable key to re-find the pick -- but the closing read actually re-finds picks with
 * findMatchingRow(), a scored search over player/stat/side/matchup that never looks at matchKey.
 * Nothing needs this key to survive a line change, and leaving the line out actively broke Alt
 * boards: the same player/stat/side offered at two different lines produced the same key, so
 * ticking the second one was silently treated as an update of the first instead of a separate
 * pick.
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
  takenLine: number | null;
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
    input.takenLine ?? "-",
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
    takenLine: row.takenLine,
    gameStartTime: row.gameStartTimeIso,
  });
}
