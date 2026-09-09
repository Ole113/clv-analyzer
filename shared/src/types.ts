export type SiteId = "ODDSJAM" | "PROPPROFESSOR";
export type PickSide = "OVER" | "UNDER";

/** One sportsbook (or fantasy book) cell as rendered in a row. */
export interface BookLine {
  /** Normalized key, e.g. "fanduel". Falls back to "col-7" when the logo is unidentifiable. */
  bookKey: string;
  /** Human label when discoverable (img alt/title/aria-label). */
  label: string | null;
  line: number | null;
  /** American odds. */
  price: number | null;
  rawText: string;
}

/** A single Fantasy Optimizer row, parsed identically at open time and at close time. */
export interface ParsedRow {
  rowIndex: number;
  player: string | null;
  team: string | null;
  opponent: string | null;
  matchup: string | null;
  sport: string | null;
  statMarket: string | null;
  side: PickSide | null;
  takenLine: number | null;
  /**
   * The site's own no-vig probability for this pick ("% CHANCE TO HIT" on OddsJam, "Value" on
   * PropProfessor), as 0-1. This is the market's fair price for the exact line taken, which is
   * what true EV% needs -- deriving it ourselves would need both sides' prices at the same line.
   */
  fairProbability: number | null;
  gameStartTimeText: string | null;
  /** Resolved to an absolute instant by the browser (which knows the local TZ). */
  gameStartTimeIso: string | null;
  externalPropId: string | null;
  externalPlayerId: string | null;
  bookLines: BookLine[];
  rawText: string;
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
