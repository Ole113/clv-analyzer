import { screenPageUrl, type ClosingReadOutcome, type ClosingWorkItem } from "@clv/shared";
import { prisma } from "./prisma";
import type { MarketType, Side } from "./constants";
import { buildClosingVerdict, type ClosingSourceSite, type ClosingVerdict } from "./closing";
import { getAppSettings, sortByBookOrder } from "./app-settings";
import { NoTokenError, TokenRejectedError, readScreenNow } from "./pp-screen-read";
import {
  NoOddsApiKeyError,
  OddsApiKeyRejectedError,
  OddsApiQuotaExhaustedError,
  getOddsApiQuota,
  readOddsApiNow,
  type OddsApiQuota,
} from "./odds-api-read";

/**
 * On-demand "what does PropProfessor say right now" reads, triggered by the Odds modal on a bet
 * page rather than by the scheduled closing-read poller. Reuses the poller's own machinery end to
 * end -- the same screen request, the same matcher, the same `buildClosingVerdict` -- so a preview
 * looks and is computed exactly like a real closing snapshot; the only difference is that nothing
 * here is ever written to the bet's own `closeLines`/`avgClosingLine`. A preview is a look, not a
 * record.
 *
 * There are two ways that read can happen, and `previewNow` below tries them in order:
 *
 *  1. **Straight from the server** (`pp-screen-read.ts`), using the bearer token the extension
 *     relays here. One HTTPS POST, answered inside the modal's own request -- no queue, no alarm,
 *     no polling.
 *  2. **Through the extension**, the original path, kept because it is the only one that can mint a
 *     token. It costs a `chrome.alarms` period (60s floor) and so is strictly a fallback: used on
 *     the first read after a restart, and after a token expires. It refreshes the server's token as
 *     a side effect, so the *next* read takes path 1.
 *
 * State lives in memory, not the database, on purpose: this app runs as one long-lived Node
 * process (the grading and closing pollers already depend on that -- see the `[grader] started`
 * log line at boot), and a preview request/result pair only ever needs to survive the few seconds
 * between the modal opening and the extension's next poll picking it up. A database row would
 * need its own cleanup story for something this disposable.
 */

export interface OddsPreview {
  fetchedAt: string;
  ok: boolean;
  /** Set when `ok` is false -- why there is nothing to show. */
  reason: string | null;
  verdict: ClosingVerdict | null;
  /**
   * The read failed because PropProfessor refused the token this server was holding.
   *
   * Surfaced rather than folded into `reason` because it is the one failure the *caller* can do
   * something about: the extension answers it by minting a fresh token and asking again, which is
   * a thing only the extension can do. See `TokenRejectedError`.
   */
  tokenRejected?: boolean;
  /**
   * The odds screen, filtered to exactly this market, game and player.
   *
   * Null whenever the read did not match a row, since the identifiers this is built from are the
   * screen's own and come back with the row -- there is nothing to point at until there is. The
   * modals fall back to the bare screen, which is where the link always used to go.
   */
  screenUrl?: string | null;
  /**
   * Which source answered. Absent on the PropProfessor path so every existing caller and stored
   * shape is untouched; set only by the Odds modal's second tab.
   */
  source?: OddsSource;
  /**
   * What is left of this month's Odds API quota, off the response's own headers. Only ever set on
   * an `ODDS_API` read, and shown in that tab's footer so the cost of a click is never a mystery.
   */
  quota?: OddsApiQuota | null;
  /**
   * The answer came from the minute-long cache rather than a fresh request, so no credit was
   * spent. Surfaced because Refresh on this tab deliberately does not bypass that cache -- the
   * source republishes once a minute and a re-fetch inside the window would buy identical bytes.
   */
  servedFromCache?: boolean;
}

/**
 * Which source a lookup should ask.
 *
 * PropProfessor is the default everywhere and is what the modal loads on open. The Odds API is
 * opt-in per click because it is metered -- see `odds-api-read.ts` for the credit arithmetic.
 */
export type OddsSource = "PROPPROFESSOR" | "ODDS_API";

// On `globalThis`, the same way `prisma.ts` pins its client: Next.js compiles Server Actions and
// Route Handlers as separate module graphs, so a plain module-level `const` here would give each
// its own, unrelated `Map` instance -- an action's `enqueuePreview` and a route's
// `takePendingPreviews` would each be talking to themselves. `globalThis` is the one thing both
// graphs actually share within the process.
const globalForPreview = globalThis as unknown as {
  clvaPreviewPending?: Map<string, ClosingWorkItem>;
  clvaPreviewResults?: Map<string, OddsPreview>;
};
const pending = globalForPreview.clvaPreviewPending ?? new Map<string, ClosingWorkItem>();
const results = globalForPreview.clvaPreviewResults ?? new Map<string, OddsPreview>();
globalForPreview.clvaPreviewPending = pending;
globalForPreview.clvaPreviewResults = results;

export function enqueuePreview(item: ClosingWorkItem): void {
  pending.set(item.id, item);
  // A fresh request supersedes whatever the last one found -- otherwise the modal would flash a
  // stale result while the new read is still in flight.
  results.delete(item.id);
}

/** Called by the extension-facing poll route. Clears the queue it returns -- see the module
 *  comment on `server/src/app/api/odds-preview-work/route.ts` for why a lease is overkill here. */
export function takePendingPreviews(): ClosingWorkItem[] {
  const items = [...pending.values()];
  pending.clear();
  return items;
}

export function isPreviewPending(betId: string): boolean {
  return pending.has(betId);
}

export function getPreviewResult(betId: string): OddsPreview | null {
  return results.get(betId) ?? null;
}

/**
 * How many finished previews are kept.
 *
 * Both maps are in-process and nothing ever deletes a result once the modal has read it, so without
 * a bound a long-running server accumulates one `ClosingVerdict` -- every book line of it -- per
 * Odds click, for the life of the process. Insertion order is what `Map` iterates in, so the oldest
 * entry is simply the first key, and only a preview nobody has looked at in hundreds of clicks is
 * ever dropped.
 */
const MAX_RESULTS = 200;

function rememberResult(betId: string, preview: OddsPreview): void {
  results.set(betId, preview);
  while (results.size > MAX_RESULTS) {
    const oldest = results.keys().next();
    if (oldest.done) break;
    results.delete(oldest.value);
  }
}

/**
 * Why there is nothing to show, in the words of whichever source was asked.
 *
 * The source is named rather than left generic because the modal shows two tabs side by side: "not
 * listing this market right now" is only actionable if the reader knows *which* of the two said it,
 * and a user looking at an empty Odds API tab should not be told PropProfessor has no market.
 */
function reasonFor(
  outcome: Exclude<ClosingReadOutcome, { kind: "MATCHED" }>,
  source: OddsSource = "PROPPROFESSOR"
): string {
  const name = source === "ODDS_API" ? "The Odds API" : "PropProfessor";
  switch (outcome.kind) {
    case "SELECTION_ABSENT":
      return `Not currently among the ${outcome.candidateCount} selections ${name} lists for this market.`;
    case "MARKET_NOT_OFFERED":
      return `${name} isn't listing this market right now -- the game may have started or ended.`;
    case "NO_CLOSING_MARKET":
    case "READ_FAILED":
      return outcome.reason;
  }
}

/**
 * The "open this on PropProfessor" link for a matched read.
 *
 * Built from the matched row rather than from the pick, because the screen filters on its own
 * spellings and ours are routinely different -- the row is where its `gameId` and its `participant`
 * come back to us. `row.player` is that participant on a player prop and null on a game market,
 * which is exactly the distinction the link wants anyway.
 */
function screenUrlFor(outcome: Extract<ClosingReadOutcome, { kind: "MATCHED" }>): string {
  return screenPageUrl({
    league: outcome.source?.league ?? null,
    market: outcome.source?.market ?? null,
    gameId: outcome.row.externalGameId,
    participant: outcome.row.player,
  });
}

/**
 * Turns a read outcome into a preview, computed the same way a real close is.
 *
 * `source` defaults to PropProfessor so the extension-facing callback route -- which only ever
 * reports PropProfessor reads -- needs no change and cannot accidentally mislabel one.
 */
export async function recordPreviewResult(
  betId: string,
  outcome: ClosingReadOutcome,
  source: OddsSource = "PROPPROFESSOR"
): Promise<void> {
  const fetchedAt = new Date().toISOString();

  if (outcome.kind !== "MATCHED") {
    rememberResult(betId, {
      fetchedAt,
      ok: false,
      reason: reasonFor(outcome, source),
      verdict: null,
      source,
    });
    return;
  }

  const bet = await prisma.bet.findUnique({ where: { id: betId } });
  if (!bet) return; // deleted while the read was in flight; nothing left to show it on

  const settings = await getAppSettings();
  const verdict = buildClosingVerdict(
    bet.marketType as MarketType,
    bet.side as Side | null,
    bet.takenLine,
    outcome.row,
    settings.useWeightedAverage ? settings.bookWeights : null,
    source === "ODDS_API" ? "ODDS_API" : "PP_SCREEN",
    { openFairProb: bet.openFairProb, useLiquidityWeighting: settings.useLiquidityWeighting }
  );
  // Same book order the "When you took it" / "At market close" tables use -- see Books in Settings.
  verdict.closeLines = sortByBookOrder(verdict.closeLines, settings.bookOrder);

  rememberResult(betId, {
    fetchedAt,
    ok: true,
    reason: null,
    verdict,
    // The Odds API has no page of its own to deep-link into.
    screenUrl: source === "ODDS_API" ? null : screenUrlFor(outcome),
    source,
  });
}

/** What a modal request produced: an answer now, or a request left with the extension to answer. */
export type PreviewAttempt =
  | { mode: "result"; preview: OddsPreview }
  | { mode: "queued" };

/**
 * Answers the Odds modal, preferring the server's own read.
 *
 * The fallback is chosen on one condition only -- no usable token here -- rather than on any read
 * failure. A market that genuinely has no selections, or a pick PropProfessor is not listing, is a
 * real answer and is shown as one; sending it round the extension as well would spend a minute to
 * arrive at the same sentence. Only "this server cannot make the request at all" is worth
 * escalating, because only that is something the extension can fix.
 *
 * A transport failure (`READ_FAILED`) is shown, not queued, for the same reason: the extension would
 * be hitting the same host over the same network seconds later.
 */
export async function previewNow(
  item: ClosingWorkItem,
  options: { allowCache?: boolean; source?: OddsSource } = {}
): Promise<PreviewAttempt> {
  if (options.source === "ODDS_API") return previewViaOddsApi(item);

  let outcome: ClosingReadOutcome;
  try {
    outcome = await readScreenNow(item, options);
  } catch (error) {
    if (error instanceof NoTokenError) {
      enqueuePreview(item);
      return { mode: "queued" };
    }
    outcome = {
      kind: "READ_FAILED",
      reason: error instanceof Error ? error.message : "the odds screen could not be read",
    };
  }

  await recordPreviewResult(item.id, outcome);
  const preview = getPreviewResult(item.id);
  // `recordPreviewResult` records nothing when the bet was deleted mid-read; there is no longer a
  // page to show a result on, so treat it as one.
  return preview
    ? { mode: "result", preview }
    : { mode: "result", preview: { fetchedAt: new Date().toISOString(), ok: false, reason: "This pick no longer exists.", verdict: null } };
}

/**
 * The same preview, from The Odds API.
 *
 * Never queues. The extension fallback exists solely because only a browser can mint a
 * PropProfessor session; a keyed API has nothing for it to contribute, so every outcome here --
 * including "no key configured" -- is a final answer shown in the tab rather than a request handed
 * off to wait on an alarm.
 */
async function previewViaOddsApi(item: ClosingWorkItem): Promise<PreviewAttempt> {
  const fetchedAt = new Date().toISOString();
  try {
    const { outcome, quota, servedFromCache } = await readOddsApiNow(item);
    await recordPreviewResult(item.id, outcome, "ODDS_API");
    const preview = getPreviewResult(item.id);
    return {
      mode: "result",
      preview: preview
        ? { ...preview, quota, servedFromCache }
        : {
            fetchedAt,
            ok: false,
            reason: "This pick no longer exists.",
            verdict: null,
            source: "ODDS_API",
          },
    };
  } catch (error) {
    return {
      mode: "result",
      preview: {
        fetchedAt,
        ok: false,
        reason: oddsApiErrorMessage(error),
        verdict: null,
        source: "ODDS_API",
        quota: getOddsApiQuota(),
      },
    };
  }
}

/** The three Odds API failures a person can actually fix, each said with the fix in it. */
function oddsApiErrorMessage(error: unknown): string {
  if (error instanceof NoOddsApiKeyError) {
    return "No Odds API key is set. Add one under Settings -> Odds API, then try again.";
  }
  if (error instanceof OddsApiKeyRejectedError) {
    return "The Odds API rejected your key. Check it under Settings -> Odds API.";
  }
  if (error instanceof OddsApiQuotaExhaustedError) {
    return "This month's Odds API quota is used up. It resets on your plan's renewal date; the PropProfessor tab still works.";
  }
  return error instanceof Error ? error.message : "The Odds API could not be read";
}

/**
 * What the odds screen says about a market nobody has ticked yet.
 *
 * `previewNow` above answers "what is this *pick* worth right now" and needs a bet row to do it --
 * the taken line, the side and the capture-time fair probability all come out of the database. This
 * answers the same question for a row sitting on a board the user is still looking at, where there
 * is no bet and may never be one: the identity arrives from the extension's own parse instead.
 *
 * Everything past the read is identical, deliberately. The same `buildClosingVerdict` with the same
 * settings produces the numbers, so the modal on an OddsJam board and the modal on `/bets` cannot
 * disagree about what the market is -- which is the entire point of showing it in both places.
 *
 * Nothing here writes: no bet, no snapshot, not even a preview result. A look is a look.
 */
export async function lookupOddsNow(
  item: ClosingWorkItem,
  options: { allowCache?: boolean; source?: OddsSource } = {}
): Promise<OddsPreview> {
  return options.source === "ODDS_API"
    ? lookupViaOddsApi(item)
    : lookupViaPropProfessor(item, options);
}

/** The default source. Unchanged from before the second source existed. */
async function lookupViaPropProfessor(
  item: ClosingWorkItem,
  options: { allowCache?: boolean }
): Promise<OddsPreview> {
  let outcome: ClosingReadOutcome;
  try {
    outcome = await readScreenNow(item, options);
  } catch (error) {
    const rejected = error instanceof TokenRejectedError;
    return {
      fetchedAt: new Date().toISOString(),
      ok: false,
      reason: rejected
        ? "Your PropProfessor session expired. Open propprofessor.com, make sure you are signed in, then try again."
        : error instanceof NoTokenError
          ? "This server has no PropProfessor session yet. Open propprofessor.com in a tab and try again."
          : error instanceof Error
            ? error.message
            : "the odds screen could not be read",
      verdict: null,
      tokenRejected: rejected,
      source: "PROPPROFESSOR",
    };
  }

  const fetchedAt = new Date().toISOString();
  if (outcome.kind !== "MATCHED") {
    return {
      fetchedAt,
      ok: false,
      reason: reasonFor(outcome, "PROPPROFESSOR"),
      verdict: null,
      source: "PROPPROFESSOR",
    };
  }

  return {
    fetchedAt,
    ok: true,
    reason: null,
    verdict: await verdictFor(item, outcome.row, "PP_SCREEN"),
    screenUrl: screenUrlFor(outcome),
    source: "PROPPROFESSOR",
  };
}

/**
 * The second source, reached only when the modal's Odds API tab is clicked.
 *
 * Note what is *not* here: no token, no extension fallback, no queueing. Those exist on the
 * PropProfessor path because that read borrows a browser session and only the extension can mint
 * one. A keyed API needs none of it -- the server either has the key or it does not, and when it
 * does the answer arrives inside this request or not at all.
 *
 * The three thrown errors are the three a person can actually fix, and each says what to do. Every
 * other failure is already a `READ_FAILED` outcome carrying its own reason.
 */
async function lookupViaOddsApi(item: ClosingWorkItem): Promise<OddsPreview> {
  let result: Awaited<ReturnType<typeof readOddsApiNow>>;
  try {
    result = await readOddsApiNow(item);
  } catch (error) {
    return {
      fetchedAt: new Date().toISOString(),
      ok: false,
      reason: oddsApiErrorMessage(error),
      verdict: null,
      source: "ODDS_API",
      quota: getOddsApiQuota(),
    };
  }

  const fetchedAt = new Date().toISOString();
  const common = {
    source: "ODDS_API" as const,
    quota: result.quota,
    servedFromCache: result.servedFromCache,
  };
  if (result.outcome.kind !== "MATCHED") {
    return {
      fetchedAt,
      ok: false,
      reason: reasonFor(result.outcome, "ODDS_API"),
      verdict: null,
      ...common,
    };
  }

  return {
    fetchedAt,
    ok: true,
    reason: null,
    verdict: await verdictFor(item, result.outcome.row, "ODDS_API"),
    // The Odds API has no page of its own to deep-link into, so this stays null and the modal
    // falls back to explaining where the numbers came from rather than offering a dead link.
    screenUrl: null,
    ...common,
  };
}

/**
 * The verdict for a matched lookup row.
 *
 * Shared by both sources deliberately and in full: the same settings, the same weighting, the same
 * `lookup: true`, the same book ordering. It is the single reason the two tabs are comparable at
 * all -- everything that turns quotes into a number happens here, once.
 */
async function verdictFor(
  item: ClosingWorkItem,
  row: Parameters<typeof buildClosingVerdict>[3],
  sourceSite: ClosingSourceSite
): Promise<ClosingVerdict> {
  const settings = await getAppSettings();
  const verdict = buildClosingVerdict(
    item.marketType as MarketType,
    item.side as Side | null,
    // A row with no line of its own still has a market worth reading; 0 is only ever used as the
    // baseline `edge` is measured from, and the caller is told the line rather than the edge.
    item.takenLine ?? 0,
    row,
    settings.useWeightedAverage ? settings.bookWeights : null,
    sourceSite,
    { useLiquidityWeighting: settings.useLiquidityWeighting, lookup: true }
  );
  // Same book order the "When you took it" / "At market close" tables use -- see Books in Settings.
  verdict.closeLines = sortByBookOrder(verdict.closeLines, settings.bookOrder);
  return verdict;
}
