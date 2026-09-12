import type { ClosingReadOutcome, ClosingWorkItem } from "@clv/shared";
import { prisma } from "./prisma";
import type { MarketType, Side } from "./constants";
import { buildClosingVerdict, type ClosingVerdict } from "./closing";
import { getAppSettings } from "./app-settings";
import { NoTokenError, readScreenNow } from "./pp-screen-read";

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
}

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

function reasonFor(outcome: Exclude<ClosingReadOutcome, { kind: "MATCHED" }>): string {
  switch (outcome.kind) {
    case "SELECTION_ABSENT":
      return `Not currently among the ${outcome.candidateCount} selections PropProfessor lists for this market.`;
    case "MARKET_NOT_OFFERED":
      return "PropProfessor isn't listing this market right now -- the game may have started or ended.";
    case "NO_CLOSING_MARKET":
    case "READ_FAILED":
      return outcome.reason;
  }
}

/** Turns a read outcome into a preview, computed the same way a real close is. */
export async function recordPreviewResult(betId: string, outcome: ClosingReadOutcome): Promise<void> {
  const fetchedAt = new Date().toISOString();

  if (outcome.kind !== "MATCHED") {
    rememberResult(betId, { fetchedAt, ok: false, reason: reasonFor(outcome), verdict: null });
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
    "PP_SCREEN",
    { openFairProb: bet.openFairProb, useLiquidityWeighting: settings.useLiquidityWeighting }
  );

  rememberResult(betId, { fetchedAt, ok: true, reason: null, verdict });
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
  options: { allowCache?: boolean } = {}
): Promise<PreviewAttempt> {
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
  options: { allowCache?: boolean } = {}
): Promise<OddsPreview> {
  let outcome: ClosingReadOutcome;
  try {
    outcome = await readScreenNow(item, options);
  } catch (error) {
    return {
      fetchedAt: new Date().toISOString(),
      ok: false,
      reason:
        error instanceof NoTokenError
          ? "This server has no PropProfessor session yet. Open propprofessor.com in a tab and try again."
          : error instanceof Error
            ? error.message
            : "the odds screen could not be read",
      verdict: null,
    };
  }

  const fetchedAt = new Date().toISOString();
  if (outcome.kind !== "MATCHED") {
    return { fetchedAt, ok: false, reason: reasonFor(outcome), verdict: null };
  }

  const settings = await getAppSettings();
  const verdict = buildClosingVerdict(
    item.marketType as MarketType,
    item.side as Side | null,
    // A row with no line of its own still has a market worth reading; 0 is only ever used as the
    // baseline `edge` is measured from, and the caller is told the line rather than the edge.
    item.takenLine ?? 0,
    outcome.row,
    settings.useWeightedAverage ? settings.bookWeights : null,
    "PP_SCREEN",
    { useLiquidityWeighting: settings.useLiquidityWeighting }
  );

  return { fetchedAt, ok: true, reason: null, verdict };
}
