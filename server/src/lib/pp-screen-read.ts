import {
  findMatchingRow,
  normalizeScreenMarket,
  planScreenRead,
  type ClosingReadOutcome,
  type ClosingSourceInfo,
  type ClosingWorkItem,
  type ParsedRow,
  type ScreenReadPlan,
} from "@clv/shared";
import { getPpToken, markTokenRejected } from "./pp-token";

/**
 * Reads PropProfessor's odds screen from the server, for the Odds modal.
 *
 * ## Why this exists alongside the extension's reader
 *
 * `extension/src/background/closing-reader.ts` does the same read in the browser, and it stays the
 * authority for *scheduled* closing reads -- those run on a 60-second alarm where a minute of
 * latency costs nothing and the browser is the only thing guaranteed to hold a live session.
 *
 * The Odds modal is the opposite case: a person is sitting there watching a spinner. Routed through
 * the extension it cost a full `chrome.alarms` period (1 minute is the floor Chrome enforces; the
 * alarm also runs the whole closing queue first) plus the modal's own 3-second poll before anything
 * appeared. The read itself is one HTTPS POST that returns in a few hundred milliseconds. Doing it
 * here removes the queue, the alarm, and the polling from the path entirely.
 *
 * The extension path is kept as the fallback, not deleted: it is the only thing that can *mint* a
 * token, so the first read after a restart -- and any read after the token expires -- still goes
 * round that way, and refreshes this cache as a side effect.
 *
 * ## What is NOT read here
 *
 * PropProfessor only. OddsJam is never contacted from the server for the same reason it is never
 * contacted from the extension: that subscription is paid a year up front and a ban is
 * unrecoverable, while the PropProfessor account is replaceable. `planScreenRead` hard-codes the
 * PropProfessor endpoint and consults nothing from the bet except its market, so there is no input
 * that can steer this module at another host -- and `oddsjam-automation-guard.test.ts` asserts it.
 */

/** A screen read is one POST. Past this, something is wrong and the user should hear about it
 *  rather than watch a spinner: the extension fallback is a better answer than a longer wait. */
const REQUEST_TIMEOUT_MS = 9_000;

/**
 * How long one market's response is reused.
 *
 * Every pick on the same (league, market) shares a request -- opening the modal on four rushing-yards
 * picks in a row is one fetch, not four. Short enough that "current odds" stays honestly current:
 * sportsbook lines do not move meaningfully inside ten seconds, and the modal's Refresh button
 * bypasses this entirely so a deliberate re-check is never served from cache.
 */
const CACHE_TTL_MS = 10_000;

/** The window a cache-skipping Refresh still joins an in-flight request over, rather than firing a
 *  duplicate at PropProfessor for an answer already on its way. */
const COALESCE_MS = 1_000;

interface CacheEntry {
  fetchedAt: number;
  /** Shared so concurrent opens on the same market await one request instead of racing. */
  inFlight: Promise<unknown>;
}

const globalForCache = globalThis as unknown as { clvaScreenCache?: Map<string, CacheEntry> };
const cache = globalForCache.clvaScreenCache ?? new Map<string, CacheEntry>();
globalForCache.clvaScreenCache = cache;

function cacheKey(plan: ScreenReadPlan): string {
  return `${plan.body.league}::${plan.body.market}`;
}

export class NoTokenError extends Error {
  constructor() {
    super("no PropProfessor session token on the server");
    this.name = "NoTokenError";
  }
}

async function postScreen(plan: ScreenReadPlan, token: string): Promise<Response> {
  // Node's fetch has no default timeout at all: without this an unresponsive host would hold the
  // modal open indefinitely, which is the failure this whole module exists to avoid.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(plan.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(plan.body),
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One market's raw screen response.
 *
 * A 401 is not retried here the way the extension retries it. The extension can answer a 401 by
 * opening a tab and capturing a new token; the server has no such move, so the honest thing is to
 * drop the dead token and let the caller fall back to the extension, which will both answer this
 * read and relay a fresh token for the next one.
 */
async function fetchScreen(plan: ScreenReadPlan, allowCache: boolean): Promise<unknown> {
  const key = cacheKey(plan);
  // Refresh deliberately skips the cache, but still coalesces: a Refresh landing while an identical
  // request is already in flight should join that one rather than start a second.
  const maxAge = allowCache ? CACHE_TTL_MS : COALESCE_MS;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < maxAge) return cached.inFlight;

  const token = getPpToken();
  if (!token) throw new NoTokenError();

  const inFlight = (async () => {
    const response = await postScreen(plan, token);
    if (response.status === 401) {
      markTokenRejected(token);
      throw new NoTokenError();
    }
    if (!response.ok) throw new Error(`screen responded ${response.status}`);
    return response.json();
  })();

  cache.set(key, { fetchedAt: Date.now(), inFlight });
  // Each entry holds a whole market's response -- a hundred kilobytes or so -- and an entry past its
  // TTL can never be served again, so it is only holding memory. Swept here rather than on a timer:
  // there are a few dozen markets at most, and this is the only thing that adds to the map.
  for (const [otherKey, entry] of cache) {
    if (otherKey !== key && Date.now() - entry.fetchedAt > CACHE_TTL_MS) cache.delete(otherKey);
  }
  try {
    return await inFlight;
  } catch (error) {
    // A failed response must not be cached: the next attempt (or the Refresh button) would keep
    // replaying the same error for the whole TTL.
    if (cache.get(key)?.inFlight === inFlight) cache.delete(key);
    throw error;
  }
}

function sourceFor(plan: ScreenReadPlan): ClosingSourceInfo {
  return {
    site: "PROPPROFESSOR_SCREEN",
    url: plan.url,
    league: plan.body.league,
    market: plan.body.market,
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

/** Names of the rows we did see, so an absent selection says what *was* there. Mirrors the
 *  extension reader's own `sampleNamesFrom`, so both paths explain a miss the same way. */
function sampleNamesFrom(rows: ParsedRow[], limit = 6): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.player ?? row.subjectTeam;
    if (name) names.add(name);
    if (names.size >= limit) break;
  }
  return [...names];
}

/**
 * Reads one pick's current market, or throws `NoTokenError` when the server cannot do it alone.
 *
 * Returns the exact `ClosingReadOutcome` shape the extension reports, so everything downstream --
 * `recordPreviewResult`, `buildClosingVerdict`, the modal's own rendering -- cannot tell which path
 * produced it, and neither can diverge from the other.
 */
export async function readScreenNow(
  item: ClosingWorkItem,
  options: { allowCache?: boolean } = {}
): Promise<ClosingReadOutcome> {
  const plan = planScreenRead(item);
  if ("kind" in plan) {
    return plan.kind === "noEquivalent"
      ? { kind: "NO_CLOSING_MARKET", reason: plan.reason }
      : { kind: "READ_FAILED", reason: `${plan.reason}. Add it to MARKET_ALIASES.` };
  }

  const raw = await fetchScreen(plan, options.allowCache !== false);
  const source = sourceFor(plan);
  const parsed = normalizeScreenMarket(raw, plan);

  if (!parsed.ok) return { kind: "READ_FAILED", reason: parsed.reason ?? "unreadable response" };
  if (parsed.rows.length === 0) return { kind: "MARKET_NOT_OFFERED", source, availableMarkets: [] };

  const row = findMatchingRow(parsed.rows, targetFor(item));
  return row
    ? { kind: "MATCHED", row, source }
    : {
        kind: "SELECTION_ABSENT",
        source,
        candidateCount: parsed.rows.length,
        sampleNames: sampleNamesFrom(parsed.rows),
      };
}
