import {
  pruneGameEntries,
  resolveOddsJamUrl,
  type OddsJamGameEntry,
  type OddsJamLinkTarget,
  type OddsJamMarketEntry,
} from "@clv/shared";

/**
 * The storage half of the OddsJam deep-link cache -- everything `chrome.storage`-shaped, kept
 * separate from `@clv/shared`'s `oddsjam-site.ts` the same way `kelly-settings.ts` keeps its own
 * caching apart from `@clv/shared/kelly.ts`'s pure math.
 *
 * `capture.ts` (running on an OddsJam game page or sport-odds listing tab) is the only writer.
 * The board adapters (`oddsjam/index.ts`, `propprofessor/index.ts`) are the only readers, and are
 * running in an entirely different tab from whatever tab did the capturing -- each content-script
 * injection gets its own module instance, so the two never share the in-memory cache directly.
 * `chrome.storage.local` is what actually crosses that gap; this module's job is keeping an
 * in-memory mirror of it fresh enough that a click can be answered synchronously (see `resolveLink`)
 * without a storage round trip sitting inside the user gesture that has to call `window.open`.
 */

const GAMES_KEY = "clv:oj-games";
const marketsKey = (sportSlug: string) => `clv:oj-markets:${sportSlug}`;

/** Safety net alongside the TTL prune in `pruneGameEntries` -- a slate spanning several sports at
 *  once should never approach this, so hitting it means something is failing to prune, not that a
 *  normal week filled the cache. */
const MAX_GAME_ENTRIES = 500;

let gamesMirror: OddsJamGameEntry[] = [];
let marketsMirror: Record<string, OddsJamMarketEntry[]> = {};

/** Loads the current cache from storage into the in-memory mirror `resolveLink` reads.
 *  Call on start and on a slow interval -- see `kellySettings`'s identical refresh cadence, which
 *  this mirrors for the same reason: the board re-renders far more often than the cache changes. */
export async function refreshOddsJamIndex(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(null);
    const games = stored[GAMES_KEY];
    if (Array.isArray(games)) gamesMirror = games as OddsJamGameEntry[];

    const markets: Record<string, OddsJamMarketEntry[]> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (key.startsWith("clv:oj-markets:") && Array.isArray(value)) {
        markets[key.slice("clv:oj-markets:".length)] = value as OddsJamMarketEntry[];
      }
    }
    marketsMirror = markets;
  } catch {
    // A cache that cannot be read just means the next resolve falls further back -- see
    // resolveOddsJamUrl's own degrade order, which already handles "nothing captured yet".
  }
}

/**
 * The link for one row, resolved entirely from the in-memory mirror -- deliberately synchronous.
 *
 * `window.open` has to run inside the same call stack as the click that asked for it, or Chrome's
 * popup blocker can treat it as an unsolicited one; a storage round trip in between would risk
 * exactly that. `refreshOddsJamIndex` is what keeps the mirror this reads worth trusting.
 */
export function resolveLink(target: OddsJamLinkTarget): string | null {
  return resolveOddsJamUrl(target, gamesMirror, marketsMirror);
}

/** Upserts one captured game by its slug -- a page revisited later (kickoff time confirmed, a typo
 *  in an earlier read corrected) replaces what was there rather than duplicating it. */
export async function recordGame(entry: OddsJamGameEntry): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(GAMES_KEY);
    const current: OddsJamGameEntry[] = Array.isArray(stored[GAMES_KEY]) ? stored[GAMES_KEY] : [];
    const pruned = pruneGameEntries(
      current.filter((e) => e.slug !== entry.slug),
      Date.now()
    );
    pruned.push(entry);
    // Oldest-captured first out, once over the safety cap -- mirrors the eviction odds-preview.ts
    // uses for its own bounded result cache.
    while (pruned.length > MAX_GAME_ENTRIES) {
      let oldestIndex = 0;
      for (let i = 1; i < pruned.length; i += 1) {
        if (pruned[i].capturedAt < pruned[oldestIndex].capturedAt) oldestIndex = i;
      }
      pruned.splice(oldestIndex, 1);
    }
    await chrome.storage.local.set({ [GAMES_KEY]: pruned });
    gamesMirror = pruned;
  } catch {
    // Best effort: a game not persisted this time is simply captured again next time its page
    // loads. Nothing downstream treats this cache as authoritative.
  }
}

/** Replaces the captured vocabulary for one sport wholesale -- the freshest read is the most
 *  correct one, since each game page's own list is already the sport's complete set of markets, and
 *  overwriting (rather than merging) is what lets a market OddsJam removes eventually age out too. */
export async function recordMarkets(sportSlug: string, entries: OddsJamMarketEntry[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [marketsKey(sportSlug)]: entries });
    marketsMirror = { ...marketsMirror, [sportSlug]: entries };
  } catch {
    // Same as recordGame: an opportunistic cache, recaptured on the next matching page load.
  }
}
