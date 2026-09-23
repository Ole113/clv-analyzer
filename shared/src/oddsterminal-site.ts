/**
 * The hand-off between a board's Odds modal and a tab on Odds Terminal.
 *
 * ## Why this module is here and not in `sources/`
 *
 * It names Odds Terminal's origin, and `shared/src/sources/` is scanned by
 * `oddsjam-automation-guard.test.ts` for exactly that. The split is the same one `oddsjam-site.ts`
 * already lives on, and it is not bookkeeping: a *parser* that knows a hostname is one refactor
 * away from fetching it, whereas this module is the one place the address is written down on
 * purpose, for a tab a person's own click is about to open.
 *
 * ## The shape of the hand-off, and why it is this shape
 *
 * Odds Terminal is account-gated, Cloudflare-fronted, and proxies a paid odds feed. It is treated
 * as being in the same risk class as PropProfessor and OddsJam. What got the PropProfessor account
 * banned (2026-09) was a captured credential driving **backend-initiated** reads on a timer, firing
 * whether or not a person was looking at anything. So the arrangement here is deliberately the
 * opposite, and the properties are structural rather than a matter of care:
 *
 *  - The tab is opened by `window.open` from the board's content script, **synchronously inside
 *    the user's own click**, exactly as the OddsJam deep-link button does. Nothing schedules it.
 *  - The read happens inside that tab, against a **same-origin relative path**, using the session
 *    already in the user's own cookie jar. No credential is ever captured, stored or sent anywhere.
 *  - Neither the background worker nor the server ever names this host -- they cannot originate
 *    contact with a site whose address they do not have. The guard test asserts it.
 *
 * ## What rides in the fragment
 *
 * A request id and nothing else. The pick's identity travels to the background worker separately,
 * over `chrome.runtime.sendMessage`, and never appears in a URL -- so a player's name and the
 * matchup are not written into the address bar of a third-party site even momentarily. The id's
 * only job is to let the tab say which pending lookup it is answering.
 */

/** Where a lookup tab is opened. The only host this module names, and the only place it is named
 *  outside the extension manifest. */
export const ODDS_TERMINAL_ORIGIN = "https://oddsterminal.org";

/** The fragment key, namespaced so nothing else on the page can be mistaken for a request. */
const REQUEST_PREFIX = "#clv-ot=";

/**
 * Ids are unguessable on purpose.
 *
 * The background worker cannot check that a snapshot message came from Odds Terminal without
 * naming the host -- which is precisely what it is forbidden to do -- so the id is what
 * authenticates the answer instead: a message is only honoured when it quotes an id the worker
 * itself minted moments earlier and is still waiting on. A page trying to feed the extension a
 * fabricated snapshot would have to guess a v4 UUID inside the timeout window.
 */
export function newOddsTerminalRequestId(): string {
  // `randomUUID` is unavailable on insecure origins and in older runtimes; the fallback is only
  // ever a fallback, and both are far beyond guessable within a few seconds.
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The URL to open for a lookup: the site's own front page, carrying the request id. */
export function oddsTerminalRequestUrl(requestId: string): string {
  return `${ODDS_TERMINAL_ORIGIN}/${REQUEST_PREFIX}${encodeURIComponent(requestId)}`;
}

/**
 * The request id in a page's fragment, or null when there is not one.
 *
 * Null is the answer for every ordinary visit to Odds Terminal, and the relay does nothing at all
 * in that case -- the same gate `oddsjam-site/resolve.ts` opens with, and asserted the same way.
 * Deliberately strict about the shape: anything on that site can put a fragment in the address
 * bar, and only a well-formed request of ours may start a read.
 */
export function decodeOddsTerminalRequest(hash: string): string | null {
  if (!hash.startsWith(REQUEST_PREFIX)) return null;
  const raw = hash.slice(REQUEST_PREFIX.length);
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // Hex or UUID only, matching what `newOddsTerminalRequestId` mints. A fragment carrying anything
  // else was not written by us.
  return /^[0-9a-f-]{16,64}$/i.test(decoded) ? decoded : null;
}
