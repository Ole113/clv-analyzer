/**
 * Relays the odds-screen bearer token from page context to the background worker.
 *
 * The bridge that observes the token has to run in the page's own JS world (`world: "MAIN"`), and
 * code there cannot call `chrome.runtime`. This script runs in the extension's isolated world on
 * the same page, so it can do both halves: listen for the bridge's `postMessage` and forward it.
 *
 * The origin and source checks matter -- `window.message` is receivable by anything on the page,
 * so without them any script could feed this extension an arbitrary token.
 */

import type { PpTokenMessage } from "../shared/messages";

const CHANNEL = "clv:pp-token";

window.addEventListener("message", (event) => {
  // Only same-page, same-origin messages from our own bridge.
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;

  const data = event.data as { source?: unknown; token?: unknown } | null;
  if (!data || data.source !== CHANNEL) return;
  if (typeof data.token !== "string" || data.token.length === 0) return;

  void chrome.runtime
    .sendMessage({ type: "clv:pp-token", token: data.token } satisfies PpTokenMessage)
    .catch(() => undefined); // worker asleep; the next request captures it again
});
