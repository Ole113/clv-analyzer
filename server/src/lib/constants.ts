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
 * MONEYLINE    straight pick on one team to win, e.g. "Seattle Seahawks" -- there is no point
 *              number to key off, so the "line" tracked for CLV is the average American-odds
 *              price across the comparison sportsbooks instead, using the exact same
 *              subtraction (taken - close) as SPREAD: a price drifting further in the pick's
 *              favour after capture is a worse number for a later bettor, same as a spread doing so.
 * OTHER        a market we can store and show but cannot price or grade (parlays, exotics)
 *
 * The OddsJam rebet/fliff boards are whole-game markets rather than player props, so CLV
 * direction, matching and grading all branch on this.
 */
export const MARKET_TYPES = ["PLAYER_PROP", "GAME_TOTAL", "SPREAD", "MONEYLINE", "OTHER"] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

/**
 * PENDING          scheduled, kickoff still ahead
 * NEEDS_GAME_TIME  captured without a usable start time -- cannot be scheduled until set
 * DUE              kickoff + buffer has passed, closing fetch in flight
 * CLOSED           closing lines captured, verdict computed
 * UNAVAILABLE      the market was listed but this selection was not in it (scratched, pulled)
 * NO_CLOSING_MARKET no sportsbook prices this market at all, so no close can ever exist -- DFS-only
 *                  composites (PrizePicks "Fantasy Score") and period-qualified props. The closing
 *                  analogue of grading's UNGRADEABLE: a statement about the market, not a failure.
 *                  Folding this into UNAVAILABLE is precisely the collapse that hid the original
 *                  bug, and it also kept these picks burning fetch attempts forever.
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
  "NO_CLOSING_MARKET",
  "FETCH_FAILED",
  "LIVE_NO_CLV",
] as const;
export type Status = (typeof STATUSES)[number];

export const OPEN_STATUSES: Status[] = ["PENDING", "NEEDS_GAME_TIME", "DUE"];
export const SETTLED_STATUSES: Status[] = [
  "CLOSED",
  "UNAVAILABLE",
  "NO_CLOSING_MARKET",
  "FETCH_FAILED",
  "LIVE_NO_CLV",
];

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

/**
 * A numeric setting from the environment, falling back when it is missing or unreadable.
 *
 * `Number("15m")` is NaN, and a NaN that reaches these settings does real damage rather than just
 * being ignored: `setInterval(delay)` treats NaN as 0, so a typo in GRADE_POLL_MINUTES would turn
 * the grader's 15-minute tick into a hot loop hammering ESPN. A malformed value is a mistake in a
 * config file, so it falls back to the documented default rather than taking the process down.
 */
function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`[config] ignoring unreadable value ${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return value;
}

export const config = {
  /**
   * The closing read is a *window before* kickoff, not a single shot after it.
   *
   * It used to fire once at kickoff + 2 minutes. That cannot work on an odds screen: a game which
   * has started is no longer listed there at all, so the read found nothing 100% of the time --
   * the same "gone by the time we look" bug as the optimizer, in a new costume.
   *
   * Serving the whole window means a failed read at T-8 simply retries at T-7, T-6 and so on
   * instead of burning the pick's only chance.
   *
   * The trade-off, plainly: reading at T-3 misses the last three minutes of steam, where late
   * scratch news lands -- which biases measured CLV slightly *downward* on exactly the picks that
   * moved hardest. Reading after kickoff risks measuring nothing at all. A small known bias beats
   * a large unknown one.
   */
  closingReadOpensMinutesBefore: envNumber(process.env.CLOSING_READ_OPENS_MINUTES_BEFORE, 8),
  closingReadTargetMinutesBefore: envNumber(process.env.CLOSING_READ_TARGET_MINUTES_BEFORE, 3),
  /** Kept slightly past kickoff only so a read already in flight can still land. */
  closingReadClosesMinutesAfter: envNumber(process.env.CLOSING_READ_CLOSES_MINUTES_AFTER, 5),
  /** How long a pick handed to an extension is not handed to anyone else. */
  closingLeaseMinutes: envNumber(process.env.CLOSING_LEASE_MINUTES, 5),
  maxFetchAttempts: envNumber(process.env.MAX_FETCH_ATTEMPTS, 6),
  /**
   * A closing line read this long after kickoff is no longer really a closing line. The pick is
   * still recorded, but flagged so a late capture never masquerades as a clean one.
   */
  staleCaptureMinutes: envNumber(process.env.STALE_CAPTURE_MINUTES, 20),
  /** Hours after kickoff before a first grading attempt -- long enough for the game to finish. */
  gradeDelayHours: envNumber(process.env.GRADE_DELAY_HOURS, 3),
  maxGradeAttempts: envNumber(process.env.MAX_GRADE_ATTEMPTS, 8),
  /** How often the server checks its own database for picks due to grade. */
  gradePollMinutes: envNumber(process.env.GRADE_POLL_MINUTES, 15),
};

/**
 * When a pick first becomes readable.
 *
 * Clamped to `now` so a pick ticked four minutes before kickoff -- inside its own read window --
 * is servable immediately instead of being scheduled into the past and waiting for the next poll.
 */
export function scheduledFetchAtFor(gameStartTime: Date, now: Date = new Date()): Date {
  const opens = new Date(gameStartTime.getTime() - config.closingReadOpensMinutesBefore * 60_000);
  return opens.getTime() < now.getTime() ? now : opens;
}

/** The last instant a pick is still worth reading. */
export function closingWindowEndsAt(gameStartTime: Date): Date {
  return new Date(gameStartTime.getTime() + config.closingReadClosesMinutesAfter * 60_000);
}

/** Human-readable description of the read window, for the settings and detail pages. */
export const CLOSING_WINDOW_DESCRIPTION =
  `${config.closingReadOpensMinutesBefore}-${config.closingReadTargetMinutesBefore} min ` +
  `before kickoff`;
