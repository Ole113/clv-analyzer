export const SITES = ["ODDSJAM", "PROPPROFESSOR"] as const;
export type Site = (typeof SITES)[number];

export const SIDES = ["OVER", "UNDER"] as const;
export type Side = (typeof SIDES)[number];

/**
 * What kind of market a pick is on.
 *
 * PLAYER_PROP  a player's stat line (every PrizePicks/Underdog-style board)
 * GAME_TOTAL   combined-score total, e.g. "Total Points Over 29.5"
 * SPREAD       handicap on one team, e.g. "Seattle Seahawks +5.5"
 * OTHER        a market we can store and show but cannot price or grade (moneylines, exotics)
 *
 * The OddsJam rebet/fliff boards are whole-game markets rather than player props, so CLV
 * direction, matching and grading all branch on this.
 */
export const MARKET_TYPES = ["PLAYER_PROP", "GAME_TOTAL", "SPREAD", "OTHER"] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

/**
 * PENDING          scheduled, kickoff still ahead
 * NEEDS_GAME_TIME  captured without a usable start time -- cannot be scheduled until set
 * DUE              kickoff + buffer has passed, closing fetch in flight
 * CLOSED           closing lines captured, verdict computed
 * UNAVAILABLE      fetch ran but no sportsbook was still quoting the prop
 * FETCH_FAILED     fetch errored (auth expired, selector broke); retried up to MAX_FETCH_ATTEMPTS
 * LIVE_NO_CLV      captured from a Live board; no closing read is scheduled because the line was
 *                  already taken mid-game, so there is no "close" to measure against
 */
export const STATUSES = [
  "PENDING",
  "NEEDS_GAME_TIME",
  "DUE",
  "CLOSED",
  "UNAVAILABLE",
  "FETCH_FAILED",
  "LIVE_NO_CLV",
] as const;
export type Status = (typeof STATUSES)[number];

export const OPEN_STATUSES: Status[] = ["PENDING", "NEEDS_GAME_TIME", "DUE"];
export const SETTLED_STATUSES: Status[] = ["CLOSED", "UNAVAILABLE", "FETCH_FAILED", "LIVE_NO_CLV"];

/** Statuses that carry a real CLV verdict. Everything else must be left out of CLV aggregates. */
export const CLV_STATUSES: Status[] = ["CLOSED"];

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
