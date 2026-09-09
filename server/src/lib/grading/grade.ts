import type { GradeResult, Side } from "../constants";

/**
 * Settles a pick against the player's actual stat.
 *
 * PUSH is a real outcome, not an edge case: pick'em lines are frequently whole numbers (a 14
 * fantasy-score line, a 2 rebounds line), so landing exactly on the number happens. It is recorded
 * and then excluded from hit-rate denominators rather than being folded into either column.
 */
export function settle(side: Side, takenLine: number, actualValue: number): GradeResult {
  // Guard against float dust from summed composites (e.g. 1.5 + 2.5 + 3.5).
  const diff = Math.round((actualValue - takenLine) * 1e6) / 1e6;
  if (diff === 0) return "PUSH";
  if (side === "OVER") return diff > 0 ? "WIN" : "LOSS";
  return diff < 0 ? "WIN" : "LOSS";
}

/** Hit rate counts wins against decided picks only; pushes and ungradeables are not losses. */
export function hitRate(rows: { gradeResult: string | null }[]): {
  wins: number;
  losses: number;
  pushes: number;
  decided: number;
  rate: number | null;
} {
  const wins = rows.filter((r) => r.gradeResult === "WIN").length;
  const losses = rows.filter((r) => r.gradeResult === "LOSS").length;
  const pushes = rows.filter((r) => r.gradeResult === "PUSH").length;
  const decided = wins + losses;
  return { wins, losses, pushes, decided, rate: decided ? wins / decided : null };
}

export interface GradeOutcome {
  gradeResult: GradeResult;
  actualValue: number | null;
  gradeReason: string | null;
}

export function gradedOutcome(side: Side, takenLine: number, actualValue: number): GradeOutcome {
  return { gradeResult: settle(side, takenLine, actualValue), actualValue, gradeReason: null };
}

export function ungradeable(reason: string): GradeOutcome {
  return { gradeResult: "UNGRADEABLE", actualValue: null, gradeReason: reason };
}
