/**
 * The PropProfessor odds-screen bearer token, as the server knows it.
 *
 * The extension has always held this token (see `extension/src/background/pp-token.ts`) because it
 * lives only in the page's JS memory and has to be observed there. What is new is that the
 * extension now *relays* it here, which is what lets the Odds modal answer from the server in one
 * round trip instead of parking a request in a queue and waiting up to a minute for the extension's
 * next `chrome.alarms` tick to come and collect it.
 *
 * Three deliberate choices:
 *
 *  - **Memory only, never the database.** This mirrors the extension keeping it in
 *    `chrome.storage.session`: a credential that disappears when the process does. It is pinned to
 *    `globalThis` for the same reason `prisma.ts` pins its client -- Next.js compiles Server Actions
 *    and Route Handlers as separate module graphs, so a module-level `const` would give the route
 *    that receives the token and the action that reads it two unrelated copies.
 *  - **Never returned to a client.** Nothing here serializes the token into a response; the only
 *    readers are server-side fetches to PropProfessor.
 *  - **Staleness is discovered, not predicted.** The token is a JWT this app deliberately does not
 *    parse, exactly as the extension does not. A 401 from the screen is the signal, and
 *    `markTokenRejected` is how the caller reports one -- the stale value is dropped so the next
 *    read falls back to the extension (which can mint a fresh one) rather than retrying a
 *    credential already known to be dead.
 */

const globalForToken = globalThis as unknown as {
  clvaPpToken?: { token: string; receivedAt: number } | null;
};

export function storePpToken(token: string): void {
  globalForToken.clvaPpToken = { token, receivedAt: Date.now() };
}

export function getPpToken(): string | null {
  return globalForToken.clvaPpToken?.token ?? null;
}

/** Called after the screen answers 401: the cached token is dead, so stop offering it. */
export function markTokenRejected(token: string): void {
  if (globalForToken.clvaPpToken?.token === token) globalForToken.clvaPpToken = null;
}

/** Whether a server-side read can even be attempted. Never exposes the token itself. */
export function hasPpToken(): boolean {
  return getPpToken() !== null;
}
