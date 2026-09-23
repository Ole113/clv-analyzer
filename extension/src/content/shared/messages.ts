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
  /** This book's price at the row's own line, where it quotes it -- see `atLine` on the verdict. */
  priceAtLine: number | null;
  logoUrl: string | null;
  includedInAverage: boolean;
  /** The money resting behind this book's quote. Only exchanges (Novig, Prophet X, Kalshi,
   *  Polymarket) report this in a way worth showing; a traditional sportsbook's depth is not public,
   *  so this is null there. */
  liquidity: number | null;
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
 *  - `ODDS_TERMINAL` is answered by a tab the user's own click opens: the relay fetches it from
 *    inside that tab and the server only ever sees the bytes. See `oddsterminal-site/relay.ts`.
 */
export type OddsSource = "ODDS_API" | "ODDS_TERMINAL";

/**
 * Starts an Odds Terminal lookup the board has just opened a tab for.
 *
 * Sent immediately after `window.open`, from inside the same click, and deliberately *not*
 * answered straight away: the worker registers `requestId` as pending and holds the response open
 * until the relay in that tab reports back, so the modal's existing await-a-response shape works
 * unchanged across what is really a three-hop round trip.
 */
export interface OddsTerminalLookupMessage {
  type: "clv:odds-terminal-lookup";
  requestId: string;
  pick: OddsLookupPick;
}

/**
 * The relay asking what to fetch.
 *
 * The query is built by our server, from the market vocabulary and the user's book ordering, and
 * handed back as a relative path -- so the content script never has to know either, and a read is
 * impossible for an id the worker is not already waiting on.
 */
export interface OddsTerminalPathMessage {
  type: "clv:odds-terminal-path";
  requestId: string;
}

export interface OddsTerminalPathResponse {
  ok: boolean;
  /** Relative, always: `/api/snapshot?...`. Never carries an origin. */
  path?: string;
  reason?: string;
}

/**
 * The relay handing back the snapshot, to be told which fixture to stream.
 *
 * The middle hop of three. `/api/snapshot` serves main markets only, so it is fetched purely to
 * identify the fixture; the server resolves it and answers with the stream path to read next.
 */
export interface OddsTerminalSnapshotMessage {
  type: "clv:odds-terminal-snapshot";
  requestId: string;
  snapshot: unknown;
}

export interface OddsTerminalSnapshotResponse {
  ok: boolean;
  /** Relative, always: `/api/stream?...`. Never carries an origin. */
  streamPath?: string;
  /** Echoed back on the final hop so the parse can filter to this fixture. */
  fixture?: unknown;
  reason?: string;
}

/** The relay's answer: either the stream entries it read, or why it could not. */
export interface OddsTerminalResultMessage {
  type: "clv:odds-terminal-result";
  requestId: string;
  ok: boolean;
  /** The `data[]` entries collected off the SSE stream, plus the fixture they belong to. */
  stream?: { entries: unknown[]; fixture: unknown };
  reason?: string;
}

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
 * This message carries the `ODDS_API` path alone. `ODDS_TERMINAL` goes through
 * `OddsTerminalLookupMessage` instead, because it has to open a tab first.
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

/** Sent by the dashboard warm-up script the moment the dashboard loads. */
export interface WarmMessage {
  type: "clv:warm";
}
