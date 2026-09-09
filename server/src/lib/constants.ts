export const SITES = ["ODDSJAM", "PROPPROFESSOR"] as const;
export type Site = (typeof SITES)[number];

export const SIDES = ["OVER", "UNDER"] as const;
export type Side = (typeof SIDES)[number];

/**
 * PENDING          scheduled, kickoff still ahead
 * NEEDS_GAME_TIME  captured without a usable start time -- cannot be scheduled until set
 * DUE              kickoff + buffer has passed, closing fetch in flight
 * CLOSED           closing lines captured, verdict computed
 * UNAVAILABLE      fetch ran but no sportsbook was still quoting the prop
 * FETCH_FAILED     fetch errored (auth expired, selector broke); retried up to MAX_FETCH_ATTEMPTS
 */
export const STATUSES = [
  "PENDING",
  "NEEDS_GAME_TIME",
  "DUE",
  "CLOSED",
  "UNAVAILABLE",
  "FETCH_FAILED",
] as const;
export type Status = (typeof STATUSES)[number];

export const OPEN_STATUSES: Status[] = ["PENDING", "NEEDS_GAME_TIME", "DUE"];
export const SETTLED_STATUSES: Status[] = ["CLOSED", "UNAVAILABLE", "FETCH_FAILED"];

/**
 * Grading outcomes. Separate from `Status`, which tracks the closing-line capture only.
 * PUSH means the stat landed exactly on the line -- real whenever a line is a whole number.
 * UNGRADEABLE means no source can settle it (fantasy-score composites, CS2, tennis), not that
 * something failed; those stay hand-gradeable.
 */
export const GRADE_RESULTS = [
  "WIN",
  "LOSS",
  /** Landed exactly on the line. Excluded from both sides of hit rate, never a loss. */
  "PUSH",
  /** Player did not play, or the game was postponed/cancelled. Not a loss -- there was no result. */
  "VOID",
  /** No source can settle this market (composites, CS2, tennis). Still gradeable by hand. */
  "UNGRADEABLE",
  /** Gave up after repeated failures -- a problem to look at, not an inherent limitation. */
  "GRADE_FAILED",
] as const;
export type GradeResult = (typeof GRADE_RESULTS)[number];

export const GRADE_SOURCES = ["espn", "mlb", "manual"] as const;

/** Only decided picks count toward a hit rate; PUSH and VOID are no-action, not losses. */
export const HIT_RESULTS = ["WIN", "LOSS"] as const;
export type GradeSource = (typeof GRADE_SOURCES)[number];

export const config = {
  closingBufferMinutes: Number(process.env.CLOSING_BUFFER_MINUTES ?? 2),
  maxFetchAttempts: Number(process.env.MAX_FETCH_ATTEMPTS ?? 6),
  /**
   * A closing line read this long after kickoff is no longer really a closing line. The pick is
   * still recorded, but flagged so a late capture never masquerades as a clean one.
   */
  staleCaptureMinutes: Number(process.env.STALE_CAPTURE_MINUTES ?? 20),
  /** Hours after kickoff before a first grading attempt -- long enough for the game to finish. */
  gradeDelayHours: Number(process.env.GRADE_DELAY_HOURS ?? 3),
  maxGradeAttempts: Number(process.env.MAX_GRADE_ATTEMPTS ?? 8),
  /** How often the server checks its own database for picks due to grade. */
  gradePollMinutes: Number(process.env.GRADE_POLL_MINUTES ?? 15),
};
