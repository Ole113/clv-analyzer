/**
 * The one place Odds Terminal's address is written down.
 *
 * ## Why this module is here and not in `sources/`
 *
 * It names Odds Terminal's origin, and `shared/src/sources/` is scanned by
 * `oddsjam-automation-guard.test.ts` for exactly that. The split is the same one `oddsjam-site.ts`
 * already lives on, and it is not bookkeeping: a *planner* that knows a hostname is one refactor
 * away from fetching it, whereas this module is the one place the address is written on purpose,
 * for the one caller allowed to use it.
 *
 * ## Who may use it, and under what conditions
 *
 * Exactly one file: `extension/src/background/odds-terminal-read.ts`, the extension's own worker,
 * and only in response to a message a click produced. The guard test asserts both -- that no other
 * background or server module names this host, and that the reader has no timer, alarm or observer
 * anywhere in it.
 *
 * That restriction is the whole design, and it is what separates this from the automation that got
 * the PropProfessor account banned (2026-09). That was a **captured credential** driving reads on a
 * **timer**, firing whether or not a person was looking at anything. Here:
 *
 *  - Nothing is scheduled. A read happens because someone clicked the odds button, or not at all.
 *  - No credential is captured, stored, or sent anywhere. The request is made by the browser the
 *    user is already signed in on, with `credentials: "include"` and the extension's declared host
 *    permission, so the session cookie is attached by Chrome and never seen by this code. There is
 *    no token bridge, no header to read, nothing persisted.
 *  - The server never contacts this host at all. It is handed the entries that came back, and the
 *    only thing it does with them is arithmetic.
 *
 * A read is two requests (the slate, then one fixture's odds) plus at most two more when the first
 * five books have nothing to say about the market -- comparable to what opening the same game in
 * the site's own tab costs, which is what a person would otherwise be doing by hand.
 */

/** Where a lookup reads from. The only host this module names. */
export const ODDS_TERMINAL_ORIGIN = "https://oddsterminal.org";

/**
 * An absolute URL from one of the relative paths `sources/odds-terminal-event.ts` builds.
 *
 * Deliberately refuses anything that is not a rooted path, so a planner bug or a tampered response
 * cannot turn a "path" into a request to some other host. The planners cannot express an absolute
 * URL in the first place -- this is the second lock on the same door.
 */
export function oddsTerminalUrl(path: string): string {
  // `//host/x` is rejected as well as `https://host/x`. Concatenating it onto the origin would in
  // fact keep it on this host, but a protocol-relative string is one `new URL(path, base)` away
  // from resolving to somebody else's, and this function exists precisely so that no future caller
  // has to know which of those two it is looking at.
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`refusing to fetch a non-relative Odds Terminal path: ${path}`);
  }
  return `${ODDS_TERMINAL_ORIGIN}${path}`;
}

/** Where a person goes to sign in, when a read comes back saying they are signed out. */
export const ODDS_TERMINAL_SIGN_IN_URL = ODDS_TERMINAL_ORIGIN;
