import type { SnapshotPayload } from "@clv/shared";

export interface CaptureMessage {
  type: "clv:capture";
  payload: SnapshotPayload;
}

export interface CaptureResponse {
  ok: boolean;
  queued?: boolean;
  error?: string;
  status?: string;
}

/** Asks the server which of the rows currently on the board are already tracked. */
export interface TrackedLookupMessage {
  type: "clv:tracked";
  matchKeys: string[];
}

export interface TrackedLookupResponse {
  ok: boolean;
  /** Match keys that have an open pick on the server. */
  tracked?: string[];
  error?: string;
}

/** Removes a pick after the user unticks its row. */
export interface UntrackMessage {
  type: "clv:untrack";
  matchKey: string;
}

export interface UntrackResponse {
  ok: boolean;
  error?: string;
}

export interface TestConnectionMessage {
  type: "clv:test-connection";
}

/**
 * Carries the odds-screen bearer token from the page-context bridge to the background worker.
 * Sent by the isolated-world relay, never by the page itself.
 */
export interface PpTokenMessage {
  type: "clv:pp-token";
  token: string;
}

/** How a book's number reads on the odds screen right now. Mirrors the server's
 *  `ClosingLineRecord`, kept as its own declaration so the extension does not depend on a server
 *  module -- the two are asserted to agree by `odds-lookup.test.ts`. */
export interface OddsLookupLine {
  bookKey: string;
  label: string | null;
  line: number | null;
  price: number | null;
  logoUrl: string | null;
  includedInAverage: boolean;
}

/** The fields the server needs to find one market on PropProfessor's odds screen. */
export interface OddsLookupPick {
  sport: string | null;
  statMarket: string;
  marketType: "PLAYER_PROP" | "GAME_TOTAL" | "SPREAD" | "MONEYLINE" | "OTHER";
  player: string | null;
  subjectTeam: string | null;
  matchup: string | null;
  side: "OVER" | "UNDER" | null;
  takenLine: number | null;
  externalPropId: string | null;
  /** Set by the modal's Refresh button so a deliberate re-check skips the server's response cache. */
  refresh?: boolean;
}

/**
 * Asks what a board row's market is priced at right now.
 *
 * Answered by the server rather than here: the averaging, the sportsbook allowlist and the outlier
 * test all live in `buildClosingVerdict`, and a second copy in a content script would drift from it
 * without anyone noticing. The read target is always PropProfessor regardless of which board asked.
 */
export interface OddsLookupMessage {
  type: "clv:odds-lookup";
  pick: OddsLookupPick;
}

export interface OddsLookupResponse {
  ok: boolean;
  error?: string;
  preview?: {
    fetchedAt: string;
    ok: boolean;
    reason: string | null;
    verdict: {
      avgClosingLine: number | null;
      closingBookCount: number;
      avgClosingPrice: number | null;
      closingPriceBookCount: number;
      edge: number | null;
      note: string | null;
      closeLines: OddsLookupLine[];
    } | null;
  };
}

/** Sent by the dashboard warm-up script the moment the dashboard loads. */
export interface WarmMessage {
  type: "clv:warm";
}
