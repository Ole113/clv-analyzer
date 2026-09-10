import type { GradeResult, Side } from "../constants";

/**
 * Settling whole-game markets (OddsJam rebet / fliff boards).
 *
 * These have no box-score row: a spread or a total is decided by the final scoreboard, so the
 * grader reads scores rather than a player's stat line. Kept pure so the rules can be tested
 * without touching the network.
 */

export interface SideScore {
  /** Normalized name variants for this team, used to work out whose score is whose. */
  variants: string[];
  score: number;
  /** Human label for provenance ("Seattle Seahawks 24 - Los Angeles Rams 20"). */
  label?: string;
}

/**
 * The number the bet is measured against.
 *
 * A total is settled by the combined score. A spread is settled by the bet team's margin: adding
 * the (signed) handicap to their score and comparing with the opponent. Both reduce to "one
 * number vs the line", which keeps the win/loss/push rule identical to a player prop.
 */
export function actualForTotal(scores: SideScore[]): number {
  return scores.reduce((sum, s) => sum + s.score, 0);
}

/**
 * The bet team's adjusted margin: their score minus the opponent's. Compared against the negated
 * handicap, so "Seahawks +5.5" wins when margin > -5.5 (i.e. they lose by fewer than 5.5).
 *
 * Returns null when the team cannot be identified, which must be reported rather than guessed --
 * grading the wrong side of a spread is worse than not grading it.
 */
export function marginForSpread(
  scores: SideScore[],
  subjectTeam: string,
  matches: (boardName: string, variants: string[]) => boolean
): number | null {
  if (scores.length !== 2) return null;
  const index = scores.findIndex((s) => matches(subjectTeam, s.variants));
  // Exactly one side must claim the team; two matches means the names are too loose to trust.
  if (index === -1) return null;
  if (scores.filter((s) => matches(subjectTeam, s.variants)).length > 1) return null;
  const mine = scores[index];
  const theirs = scores[1 - index];
  return mine.score - theirs.score;
}

/**
 * Win / loss / push for a game market.
 *
 * `value` is the combined score for a total, or the bet team's margin for a spread or moneyline.
 * For a spread the comparison is against the negated handicap: taking +5.5 means the margin must
 * beat -5.5. A moneyline is the same margin with no handicap to beat -- any positive margin wins,
 * any negative margin loses, and an exact tie pushes rather than being called either way.
 */
export function settleGameMarket(
  marketType: "GAME_TOTAL" | "SPREAD" | "MONEYLINE",
  side: Side | null,
  line: number,
  value: number
): GradeResult {
  if (marketType === "MONEYLINE") {
    if (value === 0) return "PUSH";
    return value > 0 ? "WIN" : "LOSS";
  }
  if (marketType === "SPREAD") {
    const needed = -line;
    if (value === needed) return "PUSH";
    return value > needed ? "WIN" : "LOSS";
  }
  if (value === line) return "PUSH";
  if (side === "UNDER") return value < line ? "WIN" : "LOSS";
  return value > line ? "WIN" : "LOSS";
}
