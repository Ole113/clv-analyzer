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

export const config = {
  closingBufferMinutes: Number(process.env.CLOSING_BUFFER_MINUTES ?? 2),
  maxFetchAttempts: Number(process.env.MAX_FETCH_ATTEMPTS ?? 6),
  /**
   * A closing line read this long after kickoff is no longer really a closing line. The pick is
   * still recorded, but flagged so a late capture never masquerades as a clean one.
   */
  staleCaptureMinutes: Number(process.env.STALE_CAPTURE_MINUTES ?? 20),
};
