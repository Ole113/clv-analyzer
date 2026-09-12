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
 * The token is also relayed to the CLV server (`POST /api/pp-token`), which is what lets the Odds
 * modal answer a "current odds" click in one round trip instead of parking it in a queue until this
 * worker's next alarm. Only the change is relayed, not every observation -- the bridge sees the
 * header on every request PropProfessor's own app makes -- plus a re-push whenever the server says
 * it has none, since the server holds it in memory and a restart forgets it.
 *
 * `ensureServerToken` is the front door for all of that and is called *ahead* of need: on browser
 * startup, on every closing alarm, and the moment the dashboard is opened. The modal's slow
 * "waiting on your browser extension" path still exists, but it should now only be reached when
 * PropProfessor itself cannot be signed into.
 *
 * Opening a tab is a step back toward what this redesign removed, and it is worth being precise
 * about why it is acceptable here where it was not for OddsJam. It only ever targets
 * propprofessor.com, which the user has said is expendable; it happens roughly once per token
 * lifetime rather than once per pick; and it is skipped entirely whenever a cached token still
 * works. OddsJam is not reachable from this path at all.
 */

import { apiUrl, loadSettings } from "../content/shared/config";

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
  void relayToken(token);
}

/** Hands the token to the CLV server. Best effort: a server that cannot be reached just means the
 *  Odds modal falls back to the queue, which is exactly what it did before this existed. */
async function relayToken(token: string): Promise<void> {
  try {
    const settings = await loadSettings();
    if (!settings.backendUrl || !settings.apiKey) return;
    await fetch(apiUrl(settings.backendUrl, "/api/pp-token"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify({ token }),
    });
  } catch {
    // Offline, or the backend is down. Nothing to do: `ensureServerToken` retries on the next alarm.
  }
}

const MINT_ATTEMPT_KEY = "clv:pp-token-mint-attempt";
/**
 * How long to wait before opening another tab to mint a token, after an attempt that produced none.
 *
 * A failed mint means something a retry cannot fix -- signed out of PropProfessor, or the
 * subscription lapsed -- and `ensureServerToken` runs on a 60-second alarm. Without this it would
 * open a background tab every single minute, forever, at the one site this project is allowed to
 * touch automatically. Ten minutes keeps the recovery quick once the user does sign in, while
 * making the pathological case cost six tab-opens an hour rather than sixty.
 */
const MINT_BACKOFF_MS = 10 * 60_000;

async function mintedRecently(): Promise<boolean> {
  const stored = await chrome.storage.session.get(MINT_ATTEMPT_KEY);
  const last = stored[MINT_ATTEMPT_KEY] as number | undefined;
  return typeof last === "number" && Date.now() - last < MINT_BACKOFF_MS;
}

/**
 * Makes sure the server can read the odds screen, before anyone asks it to.
 *
 * This is what turns the Odds modal's "waiting on your browser extension" state from the normal
 * case into an unusual one. Nothing here is new capability -- the token was always obtainable, and
 * always relayed once obtained -- it is purely a matter of *when*: this runs on browser startup, on
 * every closing alarm, and the moment the dashboard is opened, rather than lazily on the first
 * click that needs it.
 *
 * Two distinct gaps to close, hence two branches:
 *
 *  - **The browser has a token, the server does not.** The usual case, since the server holds it in
 *    memory and forgets it on restart. Cheap: ask, and relay only if it says no.
 *  - **Nobody has a token.** `chrome.storage.session` is cleared when Chrome closes, so this is
 *    every fresh browser session in which the user has not visited PropProfessor. Minting means
 *    loading the screen in a background tab and waiting for the app to make its own request, which
 *    is exactly what `getScreenToken` already does on demand -- just done up front, once, instead
 *    of inside the first click's latency budget.
 */
export async function ensureServerToken(): Promise<boolean> {
  try {
    const settings = await loadSettings();
    if (!settings.backendUrl || !settings.apiKey) return false;

    const stored = await readToken();
    if (stored) {
      // Asks first rather than pushing blindly, so the credential crosses the network only when it
      // is actually needed.
      const response = await fetch(apiUrl(settings.backendUrl, "/api/pp-token"), {
        headers: { "x-api-key": settings.apiKey },
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { hasToken?: boolean };
      if (body.hasToken === true) return true;
      await relayToken(stored.token);
      return true;
    }

    if (await mintedRecently()) return false;
    await chrome.storage.session.set({ [MINT_ATTEMPT_KEY]: Date.now() });
    // `storeToken` relays it as a side effect of caching it, so there is nothing to do with the
    // return value except report whether the server is now equipped.
    return (await captureFreshToken()) !== null;
  } catch {
    // Offline, or the backend is down. Best effort: the next alarm tries again.
    return false;
  }
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
