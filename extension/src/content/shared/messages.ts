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

/** How a book's number reads on the odds screen right now. Mirrors the server's
 *  `ClosingLineRecord`, kept as its own declaration so the extension does not depend on a server
 *  module -- the two are asserted to agree by `odds-lookup.test.ts`. */
export interface OddsLookupLine {
  bookKey: string;
  label: string | null;
  line: number | null;
  price: number | null;
  /** This book's price at the row's own line, where it quotes it -- see `atLine` on the verdict. */
  priceAtLine: number | null;
  logoUrl: string | null;
  includedInAverage: boolean;
  /** The money resting behind this book's quote. Only exchanges (Novig, Prophet X, Kalshi,
   *  Polymarket) report this in a way worth showing; a traditional sportsbook's depth is not public,
   *  so this is null there. */
  liquidity: number | null;
}

/** The fields a source needs to find the one market this row is about. */
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
  /** The board's own kickoff time for this row, when it rendered one. Narrows an Odds Terminal
   *  slate read to the hours around the game instead of a seven-day window. */
  gameStartIso?: string | null;
  /** Which source to ask. Decides the transport, not just the answer -- see `OddsSource`. */
  source?: OddsSource;
}

/**
 * The sources the Odds modal can ask. Used to be `"PROPPROFESSOR" | "ODDS_API"`; the PropProfessor
 * side was removed after that account was banned for automated access (2026-09) and is never
 * coming back -- the literal is kept out of this union so a stray one fails to compile.
 *
 * Must agree with the server's own `OddsSource` (`server/src/lib/odds-preview.ts`), which is
 * declared separately so the extension does not depend on a server module.
 *
 * The two reach their data by completely different routes, which is the whole design:
 *
 *  - `ODDS_API` is answered entirely by the server, which calls a keyed third-party API.
 *  - `ODDS_TERMINAL` is fetched by the extension's own background worker, on the session the
 *    browser is already signed in with, and the server only ever sees the entries that came back.
 *    See `background/odds-terminal-read.ts`.
 */
export type OddsSource = "ODDS_API" | "ODDS_TERMINAL";

/** What is left of this month's Odds API quota, off the API's own response headers. */
export interface OddsQuota {
  remaining: number | null;
  used: number | null;
  lastCost: number | null;
  readAt: string;
}

/**
 * Asks what a board row's market is priced at right now.
 *
 * Answered by the server rather than here: the averaging, the sportsbook allowlist and the outlier
 * test all live in `buildClosingVerdict`, and a second copy in a content script would drift from it
 * without anyone noticing. That stays true for both sources -- what differs is only who does the
 * *fetching*, never who does the arithmetic.
 *
 * One message for both sources, which is newer than it looks: Odds Terminal used to need its own
 * three-message dance because the read happened in a tab the click had to open synchronously. It
 * does not any more -- the worker fetches it directly -- so from the modal's point of view the two
 * sources are now the same round trip, and `pick.source` is the only difference.
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
    /** The odds screen filtered to this exact market, game and player. Always null now: The Odds
     *  API has no page of its own to link into. */
    screenUrl?: string | null;
    /** Which source answered. */
    source?: OddsSource;
    /** Remaining credits, shown in the modal's footer. */
    quota?: OddsQuota | null;
    /** Odds API only: the minute-long cache answered, so no credit was spent on this click. */
    servedFromCache?: boolean;
    verdict: {
      avgClosingLine: number | null;
      closingBookCount: number;
      avgClosingPrice: number | null;
      closingPriceBookCount: number;
      /**
       * The row's own line, when the books are sitting somewhere else and were therefore asked
       * about it separately. Null when there is nothing extra to show -- see the server's
       * `ClosingVerdict.atLine`.
       */
      atLine: number | null;
      avgPriceAtLine: number | null;
      priceAtLineBookCount: number;
      edge: number | null;
      note: string | null;
      closeLines: OddsLookupLine[];
    } | null;
  };
}

/**
 * The Kelly numbers, fetched from (or written to) the server's settings row.
 *
 * One message for both directions: with `save` it is a write that returns the saved state, without
 * it a plain read. The board never waits on this -- see `kellySettings()` for the fallbacks.
 */
export interface KellySettingsMessage {
  type: "clv:kelly-settings";
  save?: { bankroll: number; kellyMultiplier: number; unitSize: number };
}

export interface KellySettingsResponse {
  ok: boolean;
  error?: string;
  kelly?: {
    bankroll: number;
    kellyMultiplier: number;
    unitSize: number;
    kellyBoards: string[];
  };
}
