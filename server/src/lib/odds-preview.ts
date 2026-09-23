import type { ClosingReadOutcome, ClosingWorkItem } from "@clv/shared";
import { prisma } from "./prisma";
import type { MarketType, Side } from "./constants";
import { buildClosingVerdict, type ClosingSourceSite, type ClosingVerdict } from "./closing";
import { getAppSettings, sortByBookOrder } from "./app-settings";
import {
  NoOddsApiKeyError,
  OddsApiKeyRejectedError,
  OddsApiQuotaExhaustedError,
  getOddsApiQuota,
  readOddsApiNow,
  type OddsApiQuota,
} from "./odds-api-read";
import {
  planRelayRead,
  readRelayedStream,
  resolveRelayedFixture,
  type RelayedSnapshot,
  type RelayedStream,
} from "./odds-terminal-verdict";

/**
 * On-demand "what does the market say right now" reads, triggered by the Odds modal on a bet page
 * rather than by the scheduled closing-read poller. Reuses the poller's own machinery end to end --
 * the same matcher, the same `buildClosingVerdict` -- so a preview looks and is computed exactly
 * like a real closing snapshot; the only difference is that nothing here is ever written to the
 * bet's own `closeLines`/`avgClosingLine`. A preview is a look, not a record.
 *
 * This used to try a direct server-side read of PropProfessor's odds screen first, falling back to
 * the extension only when the server had no session token. That automation is what got the
 * PropProfessor account banned (2026-09), so nothing here reads a site with a borrowed session any
 * more. There are two sources, and neither repeats that mistake:
 *
 *  - **The Odds API** (`odds-api-read.ts`) -- a keyed, metered third-party API this server calls
 *    directly, because a key is not a hijacked browser session and the API is sold to be called.
 *  - **Odds Terminal** (`odds-terminal-verdict.ts`) -- fetched by the extension inside a tab the
 *    user's own click opened, and only ever handed to this server as bytes. `lookupFromRelay`
 *    below is that path, and the thing it conspicuously does not do is fetch anything.
 *
 * State lives in memory, not the database, on purpose: this app runs as one long-lived Node
 * process (the grading and closing pollers already depend on that -- see the `[grader] started`
 * log line at boot), and a preview request/result pair only ever needs to survive the few seconds
 * between the modal opening and the request completing. A database row would need its own cleanup
 * story for something this disposable.
 */

export interface OddsPreview {
  fetchedAt: string;
  ok: boolean;
  /** Set when `ok` is false -- why there is nothing to show. */
  reason: string | null;
  verdict: ClosingVerdict | null;
  /**
   * The odds screen, filtered to exactly this market, game and player.
   *
   * Always null now -- The Odds API has no page of its own to deep-link into. Kept on the type
   * rather than removed because `screenUrl` still names the fallback link the modal shows instead.
   */
  screenUrl?: string | null;
  /** Which source answered. Always `"ODDS_API"`; kept on every result for forward compatibility. */
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
 * Two again, after a spell at one. `PROPPROFESSOR` is gone for good -- that account was banned for
 * automated access (2026-09) and the literal is kept out of this union on purpose, so a stray
 * `"PROPPROFESSOR"` fails to compile rather than silently doing nothing.
 *
 * The two that remain reach their data by completely different routes, and the difference is the
 * whole design:
 *
 *  - `ODDS_API` is a keyed third-party API this server calls directly (`odds-api-read.ts`).
 *  - `ODDS_TERMINAL` is **never called by this server at all.** Its bytes are fetched by a content
 *    script inside a tab the user's own click opened, and POSTed here for the verdict alone. See
 *    `odds-terminal-verdict.ts`, which is where that distinction is written out in full.
 */
export type OddsSource = "ODDS_API" | "ODDS_TERMINAL";

/** How each source refers to itself in a sentence shown to the user. */
const SOURCE_NAMES: Record<OddsSource, string> = {
  ODDS_API: "The Odds API",
  ODDS_TERMINAL: "Odds Terminal",
};

// On `globalThis`, the same way `prisma.ts` pins its client: Next.js compiles Server Actions and
// Route Handlers as separate module graphs, so a plain module-level `const` here would give each
// its own, unrelated `Map` instance.
const globalForPreview = globalThis as unknown as {
  clvaPreviewPending?: Map<string, ClosingWorkItem>;
  clvaPreviewResults?: Map<string, OddsPreview>;
};
const pending = globalForPreview.clvaPreviewPending ?? new Map<string, ClosingWorkItem>();
const results = globalForPreview.clvaPreviewResults ?? new Map<string, OddsPreview>();
globalForPreview.clvaPreviewPending = pending;
globalForPreview.clvaPreviewResults = results;

/**
 * Nothing enqueues a preview any more -- The Odds API never needs to hand a request off to the
 * extension the way PropProfessor's screen used to. Kept, always answering "nothing queued", so
 * `server/src/app/api/odds-preview-work/route.ts` keeps compiling unchanged rather than needing to
 * be ripped out too.
 */
export function takePendingPreviews(): ClosingWorkItem[] {
  const items = [...pending.values()];
  pending.clear();
  return items;
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
  source: OddsSource = "ODDS_API"
): string {
  const name = SOURCE_NAMES[source];
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
 * Turns a read outcome into a preview, computed the same way a real close is.
 *
 * `source` defaults to `"ODDS_API"`, the only source there is now, so the extension-facing
 * callback route -- which still exists but is never actually fed anything, since nothing enqueues
 * a PropProfessor preview any more -- needs no change.
 */
export async function recordPreviewResult(
  betId: string,
  outcome: ClosingReadOutcome,
  source: OddsSource = "ODDS_API"
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
    "ODDS_API",
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
    screenUrl: null,
    source,
  });
}

/** What a modal request produced. Always an answer now: The Odds API is a keyed request/response
 *  API with nothing to queue against an extension alarm for. */
export type PreviewAttempt = { mode: "result"; preview: OddsPreview };

/**
 * Answers the Odds modal from The Odds API.
 *
 * Used to prefer a direct server-side read of PropProfessor's odds screen, with this as the
 * fallback. That automation is what got the PropProfessor account banned (2026-09), so this is now
 * the only path: every outcome, including "no key configured", is a final answer shown in the
 * modal rather than a request handed off to wait on an extension alarm.
 */
export async function previewNow(
  item: ClosingWorkItem,
  // `allowCache`/`source` are accepted so every existing caller compiles unchanged; there is only
  // one source now and The Odds API reader has its own fixed cache policy (see `odds-api-read.ts`).
  _options: { allowCache?: boolean; source?: OddsSource } = {}
): Promise<PreviewAttempt> {
  return previewViaOddsApi(item);
}

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
    return "This month's Odds API quota is used up. It resets on your plan's renewal date.";
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
  // `source` is accepted so every existing caller compiles unchanged; there is only one source now.
  _options: { allowCache?: boolean; source?: OddsSource } = {}
): Promise<OddsPreview> {
  return lookupViaOddsApi(item);
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


/**
 * The Odds Terminal answer, computed from a snapshot the extension's relay already fetched.
 *
 * The shape to notice is the one that is missing: there is no fetch, no cache, no timeout and no
 * credential anywhere in this function or anything it calls. It is handed a response body and
 * produces a verdict from it. Every byte of Odds Terminal data that reaches this process arrives
 * this way, as the payload of a POST from an extension acting on a click a person just made.
 *
 * Everything past the parse is identical to the Odds API path -- the same `verdictFor`, the same
 * settings, the same weighting, the same book ordering -- which is the only reason the two tabs in
 * the modal are comparable at all.
 */
export async function lookupFromRelay(
  item: ClosingWorkItem,
  relayed: RelayedStream
): Promise<OddsPreview> {
  const fetchedAt = new Date().toISOString();
  const plan = await planRelayRead(item);
  if ("kind" in plan) {
    return {
      fetchedAt,
      ok: false,
      // `noEquivalent` is a blameless dead end this source genuinely does not cover; `unmapped` is
      // a gap in our own alias table. Both are shown, but only the second is a bug.
      reason: plan.reason,
      verdict: null,
      source: "ODDS_TERMINAL",
    };
  }

  const outcome = readRelayedStream(item, plan, relayed);
  if (outcome.kind !== "MATCHED") {
    return {
      fetchedAt,
      ok: false,
      reason: reasonFor(outcome, "ODDS_TERMINAL"),
      verdict: null,
      source: "ODDS_TERMINAL",
    };
  }

  return {
    fetchedAt,
    ok: true,
    reason: null,
    verdict: await verdictFor(item, outcome.row, "ODDS_TERMINAL"),
    // No deep link. Odds Terminal has a page per market, but pointing at it would mean holding one
    // of its URLs in this process, and this server is deliberately kept ignorant of the host.
    screenUrl: null,
    source: "ODDS_TERMINAL",
  };
}
