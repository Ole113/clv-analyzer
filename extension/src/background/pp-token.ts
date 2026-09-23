/**
 * Held the PropProfessor odds-screen bearer token, and minted a fresh one -- by loading the screen
 * in a background tab -- when it had none. That tab-opening automation, on top of the scheduled
 * closing reads it fed, is what got the PropProfessor account banned (2026-09), so `captureFreshToken`
 * below is now a stub that never touches `chrome.tabs`.
 *
 * The rest of this module is unchanged and mostly harmless to leave running: `storeToken` still
 * caches whatever `content/propprofessor/token-bridge.ts` passively observes on a page the user
 * opened themselves, and still relays it to the CLV server (`POST /api/pp-token`) -- but the server
 * no longer does anything with a stored token (`pp-screen-read.ts` is disabled the same way), so
 * this is now a credential that is captured and stored for no purpose. It stays rather than being
 * deleted for the same reason `closing-reader.ts` does: so a future decision to read PropProfessor
 * again has one obvious place to undo this, and this token is never *sent* to PropProfessor --
 * only relayed to this project's own server -- so leaving it running does not reintroduce any
 * automated contact with PropProfessor itself.
 */

import { apiUrl, loadSettings } from "../content/shared/config";

const TOKEN_KEY = "clv:pp-token";

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
    // `storeToken` relays it as a side effect of caching it, so there is nothing to do with the
    // return value except report whether the server is now equipped.
    const minted = await captureFreshToken();
    // Only a *failed* attempt starts the backoff. Stamping it before trying meant a perfectly
    // successful mint also began a ten-minute lockout, so when that token later expired and was
    // dropped, the next several clicks were told there was no PropProfessor session and there was
    // nothing the user could do but wait it out or go refresh the site by hand. The backoff is
    // there to stop a hopeless case (signed out, subscription lapsed) from opening a tab every
    // minute forever -- a mint that worked is not that case.
    if (minted === null) await chrome.storage.session.set({ [MINT_ATTEMPT_KEY]: Date.now() });
    return minted !== null;
  } catch {
    // Offline, or the backend is down. Best effort: the next alarm tries again.
    return false;
  }
}

/**
 * Replaces a token PropProfessor has refused, and does not return until the server holds the
 * replacement.
 *
 * Called when a server-side read comes back `tokenRejected`. That is the one failure the server
 * cannot recover from on its own: it drops the dead token, but the only thing it can do next is ask
 * the extension, and the extension -- seeing the server has none -- would relay the very same dead
 * token straight back. That loop is why the modal kept reporting no PropProfessor session until the
 * site was refreshed by hand. `getScreenToken(true)` breaks it by clearing the cached copy first,
 * so the value that comes back is genuinely new.
 *
 * The relay is awaited rather than left to `storeToken`'s fire-and-forget one, because the caller
 * retries the read immediately: without the await it would race the POST that equips the server and
 * lose often enough to look like the bug it is fixing.
 *
 * The mint backoff still applies. It exists for the case a retry cannot fix -- signed out, or the
 * subscription lapsed -- and without it every click on a dead session would open another tab.
 */
export async function refreshServerToken(): Promise<boolean> {
  try {
    if (await mintedRecently()) return false;
    const token = await getScreenToken(true);
    if (!token) {
      await chrome.storage.session.set({ [MINT_ATTEMPT_KEY]: Date.now() });
      return false;
    }
    await relayToken(token);
    return true;
  } catch {
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
 * Used to open the screen in a background tab (or reload one the user already had open) and wait
 * for the app to reveal a fresh token. Permanently disabled: opening or reloading a PropProfessor
 * tab with no user asking is itself automated contact, and that automation is what got the
 * PropProfessor account banned (2026-09). This never touches `chrome.tabs` any more and always
 * reports no token, regardless of what a caller does with the result.
 */
async function captureFreshToken(): Promise<string | null> {
  return null;
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
