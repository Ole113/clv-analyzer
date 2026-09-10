/**
 * Holds the PropProfessor odds-screen bearer token, and gets a fresh one when it has none.
 *
 * The screen backend rejects unauthenticated requests, and the token lives only in the page's JS
 * memory, so it has to be observed there (see `content/propprofessor/token-bridge.ts`). This module
 * owns the consequences of that: caching it, noticing when it has gone stale, and prompting the app
 * to mint a new one by loading the screen in a background tab.
 *
 * The token is kept in `chrome.storage.session`, which lives in memory and is cleared when the
 * browser closes -- deliberately, so a credential is never written to disk.
 *
 * Opening a tab is a step back toward what this redesign removed, and it is worth being precise
 * about why it is acceptable here where it was not for OddsJam. It only ever targets
 * propprofessor.com, which the user has said is expendable; it happens roughly once per token
 * lifetime rather than once per pick; and it is skipped entirely whenever a cached token still
 * works. OddsJam is not reachable from this path at all.
 */

const TOKEN_KEY = "clv:pp-token";
const SCREEN_PAGE = "https://www.propprofessor.com/screen";
/** How long to wait for the app to make its own backend call after the page loads. */
const CAPTURE_TIMEOUT_MS = 30_000;

interface StoredToken {
  token: string;
  capturedAt: number;
}

export async function storeToken(token: string): Promise<void> {
  const current = await readToken();
  if (current?.token === token) return;
  await chrome.storage.session.set({ [TOKEN_KEY]: { token, capturedAt: Date.now() } });
}

async function readToken(): Promise<StoredToken | null> {
  const stored = await chrome.storage.session.get(TOKEN_KEY);
  return (stored[TOKEN_KEY] as StoredToken | undefined) ?? null;
}

export async function clearToken(): Promise<void> {
  await chrome.storage.session.remove(TOKEN_KEY);
}

/**
 * Waits for the token bridge to report a token, opening the screen in a background tab so the app
 * makes the request that reveals one.
 *
 * A tab the user already has open on PropProfessor is used in preference and left alone
 * afterwards; only a tab this function opened is closed again.
 */
async function captureFreshToken(): Promise<string | null> {
  let tabId: number | null = null;
  let opened = false;

  try {
    const existing = await chrome.tabs.query({ url: "https://www.propprofessor.com/*" });
    const usable = existing.find((t) => t.id !== undefined && t.status !== "unloaded");
    if (usable?.id !== undefined) {
      tabId = usable.id;
      // Already-loaded tabs have long since sent their Authorization header, so nudge the app into
      // making a fresh request rather than waiting for a user interaction that may never come.
      await chrome.tabs.reload(tabId).catch(() => undefined);
    } else {
      const tab = await chrome.tabs.create({ url: SCREEN_PAGE, active: false });
      if (tab.id === undefined) return null;
      tabId = tab.id;
      opened = true;
    }

    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const stored = await readToken();
      // Only accept a token seen since this attempt began; an older one is what failed already.
      if (stored && Date.now() - stored.capturedAt < CAPTURE_TIMEOUT_MS) return stored.token;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (tabId !== null && opened) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

/**
 * The token to use for a screen request.
 *
 * `forceRefresh` is passed after a 401, which is the only reliable staleness signal available --
 * the token's own expiry is inside a JWT this extension deliberately does not parse.
 */
export async function getScreenToken(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh) {
    const stored = await readToken();
    if (stored) return stored.token;
  } else {
    await clearToken();
  }
  return captureFreshToken();
}
