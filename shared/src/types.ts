export type SiteId = "ODDSJAM" | "PROPPROFESSOR";
export type PickSide = "OVER" | "UNDER";

/** See MARKET_TYPES in the server's constants for what each one means. */
export type MarketType = "PLAYER_PROP" | "GAME_TOTAL" | "SPREAD" | "MONEYLINE" | "OTHER";

/** One sportsbook (or fantasy book) cell as rendered in a row. */
export interface BookLine {
  /** Normalized key, e.g. "fanduel". Falls back to "col-7" when the logo is unidentifiable. */
  bookKey: string;
  /** Human label when discoverable (img alt/title/aria-label). */
  label: string | null;
  line: number | null;
  /** American odds. */
  price: number | null;
  /** Book logo as served by the board, absolute. Stored so the dashboard can show real icons. */
  logoUrl: string | null;
  rawText: string;
}

/** A single Fantasy Optimizer row, parsed identically at open time and at close time. */
export interface ParsedRow {
  rowIndex: number;
  marketType: MarketType;
  /** Null on game markets (spreads, totals), which have no player. */
  player: string | null;
  /** The board's own bet name, e.g. "Seattle Seahawks +5.5". */
  selectionName: string | null;
  /** For SPREAD: the team the signed line belongs to. */
  subjectTeam: string | null;
  /** True when read from a Live board rather than Pre-Match. */
  isLive: boolean;
  team: string | null;
  opponent: string | null;
  matchup: string | null;
  sport: string | null;
  statMarket: string | null;
  /** Null on spreads, where direction is carried by the sign of the line. */
  side: PickSide | null;
  takenLine: number | null;
  /**
   * The site's own no-vig probability for this pick ("% CHANCE TO HIT" on OddsJam, "Value" on
   * PropProfessor), as 0-1. This is the market's fair price for the exact line taken, which is
   * what true EV% needs -- deriving it ourselves would need both sides' prices at the same line.
   */
  fairProbability: number | null;
  /**
   * An EV% the board states directly, used where no fair probability is published. OddsJam's
   * rebet/fliff boards show "EV %" rather than a "% chance to hit", and the two are different
   * quantities -- this is recorded as-is instead of being reverse-engineered into a probability.
   */
  boardEvPercent: number | null;
  gameStartTimeText: string | null;
  /** Resolved to an absolute instant by the browser (which knows the local TZ). */
  gameStartTimeIso: string | null;
  externalPropId: string | null;
  externalPlayerId: string | null;
  bookLines: BookLine[];
  rawText: string;
}

/**
 * One pick the server has decided is due for a closing read.
 *
 * Lives here rather than in the extension because the server's `select` in
 * /api/closing-work and the worker's expectations are the same contract, and they used to be two
 * hand-maintained copies that drifted. Adding a field now means adding it once.
 */
export interface ClosingWorkItem {
  id: string;
  /** Where the pick was *captured*. Not where it is read at close -- see planScreenRead. */
  site: SiteId;
  fantasyBook: string;
  marketType: MarketType;
  /** Null on game markets (spreads, totals, moneylines). */
  player: string | null;
  /** Spreads and moneylines: the team the pick belongs to. */
  subjectTeam: string | null;
  matchup: string | null;
  statMarket: string;
  /** Null on spreads and moneylines, where the team carries the direction. */
  side: PickSide | null;
  externalPropId: string | null;
  /** Provenance only: the board this was ticked on. Never used as a read target. */
  pageUrl: string | null;
  gameStartTime: string | null;
  sport: string | null;
  takenLine: number | null;
}

/** Wire payload sent from the extension to POST /api/snapshots. */
export interface SnapshotPayload {
  site: SiteId;
  fantasyBook: string;
  pageUrl: string;
  capturedAt: string;
  sourceDevice: string | null;
  row: ParsedRow;
  rawHtml: string;
}

export interface ParseResult {
  ok: boolean;
  reason?: string;
  headers: string[];
  rows: ParsedRow[];
}

/** Which screen, and for what, so a recorded verdict can always be traced back to its source. */
export interface ClosingSourceInfo {
  site: "PROPPROFESSOR_SCREEN";
  url: string;
  league: string;
  market: string;
}

/**
 * What a closing read actually found.
 *
 * The old result type could not tell "this selection is not offered" from "the page never loaded",
 * and that collapse *is* the bug this redesign exists to fix: a pick whose market had simply moved
 * past it was recorded as UNAVAILABLE and dropped from every aggregate, which is exactly what
 * happens to the picks that were most right.
 *
 * Each kind maps to a different status and, crucially, a different retry policy -- only genuine
 * failures may burn a fetch attempt.
 */
export type ClosingReadOutcome =
  /** Found it. */
  | { kind: "MATCHED"; row: ParsedRow; source: ClosingSourceInfo }
  /** The market is listed; this player or team is not in it (scratched, pulled). Terminal. */
  | {
      kind: "SELECTION_ABSENT";
      source: ClosingSourceInfo;
      candidateCount: number;
      sampleNames: string[];
    }
  /** The market itself came back empty. Retryable while the window is open. */
  | { kind: "MARKET_NOT_OFFERED"; source: ClosingSourceInfo; availableMarkets: string[] }
  /** No sportsbook prices this market at all, so no close can ever exist. Terminal, blameless. */
  | { kind: "NO_CLOSING_MARKET"; reason: string }
  /** The read broke, or we have no alias for this market yet. Retryable and loud. */
  | { kind: "READ_FAILED"; reason: string };
