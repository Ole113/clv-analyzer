import { decodeOddsTerminalRequest } from "@clv/shared";
import type {
  OddsTerminalPathMessage,
  OddsTerminalPathResponse,
  OddsTerminalResultMessage,
} from "../shared/messages";

/**
 * Reads one market from Odds Terminal, inside the tab the user's own click just opened.
 *
 * ## This is a new capability, and it is not the one OddsJam has
 *
 * Be clear about what this file does that nothing else in this project does: **it originates an
 * HTTP request from a content script.** The two things it superficially resembles both stop
 * deliberately short of that, and saying "this is just what we already do" would be wrong:
 *
 *  - `oddsjam-site/resolve.ts` only ever *navigates* the tab it is already in (`location.assign`).
 *    It never calls `fetch`, and its guard test bans `fetch` outright across that whole directory
 *    with no exception anywhere.
 *  - PropProfessor's old `token-bridge.ts` only *monkeypatched* `window.fetch` to observe a header
 *    on a request the page was already making. It never originated one either.
 *
 * So this needs to be justified on its own terms rather than by precedent, and the justification
 * is the set of limits below -- each of which its own guard test asserts, because a rule of this
 * kind is exactly what a later refactor undoes without noticing.
 *
 * ## The limits
 *
 *  1. **Nothing happens without a request.** `decodeOddsTerminalRequest` returning null -- which is
 *     every ordinary visit to Odds Terminal -- means this module does nothing whatsoever. There is
 *     no timer, no mutation observer, and no load-time read. Someone who merely browses this site
 *     with the extension installed generates no traffic from it, ever.
 *  2. **The request id must be one the extension is waiting on.** The path is not built here; it is
 *     asked for, and the background worker answers only for an id it minted itself seconds ago and
 *     still has pending. A stale reload cannot re-run a read, because the pending entry is gone.
 *  3. **One fetch, same-origin, relative.** The path arrives from our own server as a relative
 *     path and is fetched as-is. This module cannot express a cross-origin request: it never
 *     concatenates an origin, and the guard test asserts the only `fetch` here takes a bare path.
 *  4. **It runs in the isolated world.** The session is a plain `no-store, private` cookie and is
 *     never exposed to page JS, so unlike the old PropProfessor bridge there is nothing here that
 *     needs page context. An isolated-world fetch still carries the tab's cookies while staying
 *     out of reach of the page's own CSP `connect-src`, which could otherwise simply block it.
 *  5. **No credential is read, stored or transmitted.** The cookie is used by the browser, as it
 *     would be for any click; this code never sees it and nothing about the session leaves the tab.
 */

/**
 * How long to wait for the page to be usable before giving up.
 *
 * The fetch itself does not need the page rendered -- it is an API call against the same origin --
 * but it does need the session cookie to have been established, which on a cold tab means waiting
 * for Cloudflare's challenge to settle. Generous for that reason, and a backstop rather than the
 * normal path: the normal path is one fetch, immediately.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** Removes the request from the address bar so a reload cannot look like a fresh job, and leaves
 *  the user with a clean URL for wherever they ended up. */
function clearRequest(): void {
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    // Cosmetic only. The pending-entry check in the background worker is what actually stops a
    // reload from re-reading: that entry is consumed by the first answer.
  }
}

/**
 * Whether the user is signed in, asked only when a read has already failed.
 *
 * Deliberately not a preflight. Checking the session before every read would double this
 * extension's request count against a site it is being careful with, to answer a question the
 * snapshot's own status code answers for free in the normal case. So it is a *diagnostic*: it runs
 * only to turn an unexplained 401/403 into the sentence a person can act on.
 */
async function isSignedOut(): Promise<boolean> {
  try {
    const response = await fetch("/api/session", { credentials: "include" });
    if (!response.ok) return true;
    const body = (await response.json()) as { connected?: unknown };
    return body?.connected !== true;
  } catch {
    return false; // Could not tell; the caller reports the original failure rather than guessing.
  }
}

/** Hands the background worker an answer, successful or not, for it to resolve the modal with. */
function report(message: OddsTerminalResultMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // The worker is gone or the modal was closed. Nothing to retry and nobody to tell.
  });
}

async function run(requestId: string): Promise<void> {
  clearRequest();

  // What to read is decided by our own server, not here: the market vocabulary and the user's book
  // ordering both live there, and a content script that built its own query would be a second
  // implementation of both. This also means the read cannot happen at all unless the extension is
  // already waiting on this exact id -- see limit 2 above.
  let path: string;
  try {
    const answer = (await chrome.runtime.sendMessage({
      type: "clv:odds-terminal-path",
      requestId,
    } satisfies OddsTerminalPathMessage)) as OddsTerminalPathResponse | undefined;

    if (!answer?.ok || !answer.path) {
      report({
        type: "clv:odds-terminal-result",
        requestId,
        ok: false,
        reason: answer?.reason ?? "This lookup is no longer waiting for an answer.",
      });
      return;
    }
    path = answer.path;
  } catch {
    return; // Extension context gone; there is nobody left to answer.
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // The one request this module makes. `path` is a relative path built by our server; no origin
    // is concatenated here, and none can be -- which is what makes this fetch same-origin by
    // construction rather than by convention.
    const response = await fetch(path, {
      credentials: "include",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      report({
        type: "clv:odds-terminal-result",
        requestId,
        ok: false,
        reason: (await isSignedOut())
          ? "You are signed out of Odds Terminal. Sign in on the tab that just opened, then hit Refresh."
          : "Odds Terminal refused the request for this account.",
      });
      return;
    }
    if (response.status === 429) {
      report({
        type: "clv:odds-terminal-result",
        requestId,
        ok: false,
        reason: "Odds Terminal is rate-limiting this account. Give it a minute before retrying.",
      });
      return;
    }
    if (!response.ok) {
      // The documented 400 is a wrong `sportsbook` count or name, which would be our bug rather
      // than the user's -- so the body is surfaced instead of being flattened into a status code.
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      report({
        type: "clv:odds-terminal-result",
        requestId,
        ok: false,
        reason: detail
          ? `Odds Terminal answered ${response.status}: ${detail}`
          : `Odds Terminal answered ${response.status}.`,
      });
      return;
    }

    const body = (await response.json()) as unknown;
    report({ type: "clv:odds-terminal-result", requestId, ok: true, snapshot: body });
  } catch (error) {
    report({
      type: "clv:odds-terminal-result",
      requestId,
      ok: false,
      reason:
        error instanceof Error && error.name === "AbortError"
          ? "Odds Terminal did not answer in time. If the tab is still loading, hit Refresh."
          : "Could not reach Odds Terminal from its own tab.",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The entry point, and the gate.
 *
 * The early return is the whole safety property: no request, no work, no traffic. It is asserted
 * structurally by the guard test rather than by importing this module into a Node test, which
 * would mean stubbing the entire DOM to prove one early return.
 */
export function startOddsTerminalRelay(): void {
  const requestId = decodeOddsTerminalRequest(location.hash);
  if (!requestId) return;
  void run(requestId);
}

startOddsTerminalRelay();
