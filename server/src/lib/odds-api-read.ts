import {
  findMatchingRow,
  findOddsApiEvent,
  normalizeOddsApiEvent,
  oddsApiEventsUrl,
  oddsApiOddsUrl,
  planOddsApiRead,
  type ClosingReadOutcome,
  type ClosingSourceInfo,
  type ClosingWorkItem,
  type OddsApiEvent,
  type OddsApiReadPlan,
  type ParsedRow,
} from "@clv/shared";
import { getAppSettings } from "./app-settings";

/**
 * Reads The Odds API from the server, for the Odds modal's second tab.
 *
 * ## Why this mirrors `pp-screen-read.ts` rather than reusing it
 *
 * The two do the same job and are deliberately the same shape -- abort-controller timeout, a cache
 * keyed on the request, coalescing so concurrent opens share one fetch, and a `ClosingReadOutcome`
 * out the far end that downstream code cannot distinguish by source. What they cannot share is the
 * middle: this one is a two-step call (resolve an event, then price it), it carries a key instead
 * of a borrowed session, and its cache has a different honest lifetime. Forcing one module to be
 * both would mean a flag on every line of it.
 *
 * ## What a read costs, and why the numbers here are what they are
 *
 * The Odds API bills `unique markets returned x regions`, where a group of ten named bookmakers
 * counts as one region. `planOddsApiRead` asks for exactly one market and at most ten books, so
 * **one tab click is one credit** -- see `ODDS_API_COST_PER_READ`. The event listing that resolves
 * the id costs nothing at all, which is the only reason a two-step call is affordable.
 *
 * That budget is why this module is never called on open. The modal's PropProfessor tab loads as it
 * always has; this one fires only when a person clicks its tab, and the result is cached in the
 * modal for as long as it stays open. A free account is 500 credits a month, and a design that
 * spent one on every modal open would exhaust it in a fortnight of ordinary use.
 *
 * ## What is NOT read here
 *
 * The same rule as everywhere else in this project: never OddsJam. This module names exactly one
 * host, `api.the-odds-api.com`, which is a third party to both boards, and
 * `oddsjam-automation-guard.test.ts` asserts it the same way it asserts the PropProfessor path.
 */

/** A read is two requests back to back. Past this, a person is better served by an error. */
const REQUEST_TIMEOUT_MS = 9_000;

/**
 * How long one (event, market) response is reused.
 *
 * Six times the PropProfessor cache, and the number is not a guess: The Odds API republishes props
 * on a 60-second cycle, pre-match and in-play alike, on every plan including the free one. Inside
 * that window there is by definition no new data to fetch, so a shorter TTL would spend a credit to
 * receive the bytes it already has. The PropProfessor reader stays at 10s because its source has no
 * such published floor.
 */
const CACHE_TTL_MS = 60_000;

/** The event listing changes by the round, not by the minute, and it is free either way. */
const EVENTS_CACHE_TTL_MS = 10 * 60_000;

interface CacheEntry<T> {
  fetchedAt: number;
  /** Shared so concurrent opens on the same market await one request instead of racing. */
  inFlight: Promise<T>;
}

const globalForCache = globalThis as unknown as {
  clvaOddsApiCache?: Map<string, CacheEntry<unknown>>;
  clvaOddsApiEvents?: Map<string, CacheEntry<OddsApiEvent[]>>;
  clvaOddsApiQuota?: OddsApiQuota | null;
};
const cache = globalForCache.clvaOddsApiCache ?? new Map<string, CacheEntry<unknown>>();
const eventsCache = globalForCache.clvaOddsApiEvents ?? new Map<string, CacheEntry<OddsApiEvent[]>>();
globalForCache.clvaOddsApiCache = cache;
globalForCache.clvaOddsApiEvents = eventsCache;

/** What the API says is left of this month's quota, read off every response's own headers. */
export interface OddsApiQuota {
  remaining: number | null;
  used: number | null;
  /** What the last call actually cost. Should always be 1; surfaced so a regression is visible. */
  lastCost: number | null;
  readAt: string;
}

export class NoOddsApiKeyError extends Error {
  constructor() {
    super("no Odds API key is configured");
    this.name = "NoOddsApiKeyError";
  }
}

/** The key was rejected. A different cure from "no key": the stored one is wrong, not missing. */
export class OddsApiKeyRejectedError extends Error {
  constructor() {
    super("The Odds API rejected the configured key");
    this.name = "OddsApiKeyRejectedError";
  }
}

/** The monthly quota is spent. Terminal until it resets; retrying only wastes the user's time. */
export class OddsApiQuotaExhaustedError extends Error {
  constructor() {
    super("this month's Odds API quota is used up");
    this.name = "OddsApiQuotaExhaustedError";
  }
}

export function getOddsApiQuota(): OddsApiQuota | null {
  return globalForCache.clvaOddsApiQuota ?? null;
}

/**
 * Records the quota headers every response carries.
 *
 * Kept on `globalThis` rather than returned up the call stack alone, so the modal can show a
 * remaining-credits figure even on a cache hit -- which is most of the time, and precisely when the
 * user has no fresh response to read one off.
 */
function rememberQuota(response: Response): void {
  const header = (name: string): number | null => {
    const raw = response.headers.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const remaining = header("x-requests-remaining");
  const used = header("x-requests-used");
  const lastCost = header("x-requests-last");
  // A response with none of the three is not a quota report -- don't blank a good reading with it.
  if (remaining === null && used === null && lastCost === null) return;
  globalForCache.clvaOddsApiQuota = {
    remaining,
    used,
    lastCost,
    readAt: new Date().toISOString(),
  };
}

async function request(url: string): Promise<Response> {
  // Node's fetch has no default timeout at all: without this an unresponsive host would hold the
  // modal open indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    rememberQuota(response);
    if (response.status === 401) throw new OddsApiKeyRejectedError();
    if (response.status === 429) throw new OddsApiQuotaExhaustedError();
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The events on the board for one sport.
 *
 * Free, per the published quota table, which is what makes the two-step call viable -- and cached
 * for ten minutes anyway, because a listing that changes once a round has no business being fetched
 * on every click even when it is free.
 */
async function fetchEvents(plan: OddsApiReadPlan, apiKey: string): Promise<OddsApiEvent[]> {
  const cached = eventsCache.get(plan.sportKey);
  if (cached && Date.now() - cached.fetchedAt < EVENTS_CACHE_TTL_MS) return cached.inFlight;

  const inFlight = (async () => {
    const response = await request(oddsApiEventsUrl(plan, apiKey));
    if (!response.ok) throw new Error(`the event listing responded ${response.status}`);
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) throw new Error("the event listing was not an array");
    return (body as OddsApiEvent[]).filter((e) => e && typeof e.id === "string");
  })();

  eventsCache.set(plan.sportKey, { fetchedAt: Date.now(), inFlight });
  try {
    return await inFlight;
  } catch (error) {
    if (eventsCache.get(plan.sportKey)?.inFlight === inFlight) eventsCache.delete(plan.sportKey);
    throw error;
  }
}

/** Keyed on the request: one event's market answers every pick in that game on that market. */
function cacheKey(plan: OddsApiReadPlan, eventId: string): string {
  return `${plan.sportKey}::${eventId}::${plan.market}::${plan.bookmakers.join(",")}`;
}

/**
 * One (event, market) response, the call that spends the credit.
 *
 * There is deliberately no `allowCache` escape hatch, which is the one place this diverges from
 * `pp-screen-read.ts`. On the PropProfessor path a Refresh skips the cache entirely, because that
 * read is free and a person pressing Refresh wants the freshest possible number. Here the same
 * press would spend a credit to receive byte-identical data: the source republishes once a minute,
 * and the cache TTL *is* that minute. So a Refresh inside the window is served from cache and the
 * caller is told why -- see `servedFromCache` on the result -- and only a genuinely expired entry
 * is re-fetched. Concurrent callers still share one in-flight promise, so the coalescing the other
 * reader needs a separate window for is simply the normal path here.
 */
async function fetchOdds(
  plan: OddsApiReadPlan,
  eventId: string,
  apiKey: string
): Promise<{ raw: unknown; servedFromCache: boolean }> {
  const key = cacheKey(plan, eventId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { raw: await cached.inFlight, servedFromCache: true };
  }

  const inFlight = (async () => {
    const response = await request(oddsApiOddsUrl(plan, eventId, apiKey));
    // 422 is this API's "you asked for a market this sport does not have". Not a transport failure
    // and not worth a retry: the alias table is what needs the edit.
    if (response.status === 422) {
      throw new Error(`The Odds API does not offer "${plan.market}" for ${plan.sportKey}`);
    }
    if (!response.ok) throw new Error(`The Odds API responded ${response.status}`);
    return response.json();
  })();

  cache.set(key, { fetchedAt: Date.now(), inFlight });
  // Each entry holds one market's response and an entry past its TTL can never be served again, so
  // it is only holding memory. Swept here rather than on a timer: this is the only thing that adds
  // to the map.
  for (const [otherKey, entry] of cache) {
    if (otherKey !== key && Date.now() - entry.fetchedAt > CACHE_TTL_MS) cache.delete(otherKey);
  }
  try {
    return { raw: await inFlight, servedFromCache: false };
  } catch (error) {
    // A failed response must not be cached: the next attempt would replay the same error for a
    // whole minute, and on this source that minute is long enough to look broken.
    if (cache.get(key)?.inFlight === inFlight) cache.delete(key);
    throw error;
  }
}

function sourceFor(plan: OddsApiReadPlan, eventId: string): ClosingSourceInfo {
  return {
    site: "ODDS_API",
    url: `${plan.sportKey}/${eventId}`,
    league: plan.sportKey,
    market: plan.market,
  };
}

function targetFor(item: ClosingWorkItem) {
  return {
    marketType: item.marketType,
    player: item.player,
    subjectTeam: item.subjectTeam,
    matchup: item.matchup,
    statMarket: item.statMarket,
    side: item.side,
    externalPropId: item.externalPropId,
  };
}

/** Names of the rows we did see, so an absent selection says what *was* there. */
function sampleNamesFrom(rows: ParsedRow[], limit = 6): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.player ?? row.subjectTeam;
    if (name) names.add(name);
    if (names.size >= limit) break;
  }
  return [...names];
}

export interface OddsApiReadResult {
  outcome: ClosingReadOutcome;
  /** True when the minute-long cache answered, so the modal can say "no new data yet". */
  servedFromCache: boolean;
  quota: OddsApiQuota | null;
}

/**
 * Reads one pick's current market from The Odds API.
 *
 * Returns the same `ClosingReadOutcome` shape the PropProfessor reader does, so everything
 * downstream -- `buildClosingVerdict`, the modal's rendering -- cannot tell which source produced
 * it, and neither tab can drift from the other.
 *
 * Throws only for the three conditions the *user* can act on: no key, a rejected key, an exhausted
 * quota. Everything else is a `READ_FAILED` outcome with its reason, because a message beats an
 * exception for something a person is watching.
 */
export async function readOddsApiNow(item: ClosingWorkItem): Promise<OddsApiReadResult> {
  const settings = await getAppSettings();

  // Resolved before the key is checked, deliberately. "This source does not carry 1st-half player
  // props" is true whether or not a key is configured, and it is the more specific answer -- being
  // told to go and set up an API key, only to find it could never have answered this pick anyway,
  // is a worse experience than being told so at once.
  const plan = planOddsApiRead(item, { bookOrder: settings.bookOrder });
  if ("kind" in plan) {
    return {
      outcome:
        plan.kind === "noEquivalent"
          ? { kind: "NO_CLOSING_MARKET", reason: plan.reason }
          : { kind: "READ_FAILED", reason: `${plan.reason}. Add it to ODDS_API_MARKETS.` },
      servedFromCache: false,
      quota: getOddsApiQuota(),
    };
  }

  const apiKey = settings.oddsApiKey;
  if (!apiKey) throw new NoOddsApiKeyError();

  const events = await fetchEvents(plan, apiKey);
  const event = findOddsApiEvent(events, { matchup: item.matchup, subjectTeam: item.subjectTeam });
  if (!event) {
    // The one failure mode with no analogue on the PropProfessor path, which is handed its own game
    // ids. Said plainly rather than as "market not offered", because the market is very likely fine
    // and the thing that failed was naming the fixture.
    return {
      outcome: {
        kind: "READ_FAILED",
        reason: item.matchup
          ? `The Odds API is not listing a game matching "${item.matchup}" right now. It lists only games bookmakers currently price, so this usually means the game has finished or is not yet open.`
          : "This pick records no matchup, and The Odds API needs one to identify the game.",
      },
      servedFromCache: false,
      quota: getOddsApiQuota(),
    };
  }

  const { raw, servedFromCache } = await fetchOdds(plan, event.id, apiKey);
  const source = sourceFor(plan, event.id);
  // One pick per read, so the line it was taken at is a thing that can be asked about -- the same
  // `atLine` treatment the on-demand PropProfessor read gets.
  const parsed = normalizeOddsApiEvent(raw, plan, { atLine: item.takenLine });

  if (!parsed.ok) {
    return {
      outcome: { kind: "READ_FAILED", reason: parsed.reason ?? "unreadable response" },
      servedFromCache,
      quota: getOddsApiQuota(),
    };
  }
  if (parsed.rows.length === 0) {
    return {
      outcome: { kind: "MARKET_NOT_OFFERED", source, availableMarkets: [] },
      servedFromCache,
      quota: getOddsApiQuota(),
    };
  }

  const row = findMatchingRow(parsed.rows, targetFor(item));
  return {
    outcome: row
      ? { kind: "MATCHED", row, source }
      : {
          kind: "SELECTION_ABSENT",
          source,
          candidateCount: parsed.rows.length,
          sampleNames: sampleNamesFrom(parsed.rows),
        },
    servedFromCache,
    quota: getOddsApiQuota(),
  };
}
