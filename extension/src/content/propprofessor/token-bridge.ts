/**
 * Captures the bearer token PropProfessor's own app sends to its odds-screen backend.
 *
 * `POST backend.propprofessor.com/screen` requires `Authorization: Bearer <JWT>`. The token is not
 * in a readable cookie and not in the NextAuth session payload -- the app holds it in memory and
 * attaches it per request -- so the only place it can be observed is the page's own JS context.
 *
 * Hence `world: "MAIN"`. This script runs in the page's context rather than the extension's
 * isolated world, which is the *only* reason it can see `window.fetch` as the app sees it. It is
 * deliberately as small as possible for that reason:
 *
 *  - It only ever *reads* the Authorization header off requests the app was already making. It
 *    never mints, refreshes, stores or transmits credentials of its own, and it makes no requests.
 *  - It touches nothing but `window.fetch`, and calls straight through to the original.
 *  - The token goes to the extension's own background worker via postMessage and nowhere else.
 *
 * If PropProfessor ever exposes the token somewhere readable, or drops the requirement, delete this
 * file and the manifest entry -- `pp-token.ts` is the only consumer.
 */

const CHANNEL = "clv:pp-token";
const BACKEND = "backend.propprofessor.com";

function headerFrom(input: RequestInfo | URL, init?: RequestInit): string | null {
  try {
    const fromInit = init?.headers ? new Headers(init.headers).get("authorization") : null;
    if (fromInit) return fromInit;
    if (input instanceof Request) return input.headers.get("authorization");
  } catch {
    // A malformed headers object is not worth breaking the site's own fetch over.
  }
  return null;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url ?? "";
}

const original = window.fetch;

window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
  try {
    if (urlOf(input).includes(BACKEND)) {
      const auth = headerFrom(input, init);
      if (auth && auth.startsWith("Bearer ")) {
        window.postMessage({ source: CHANNEL, token: auth.slice(7) }, window.location.origin);
      }
    }
  } catch {
    // Never let observation break the page.
  }
  return original.call(window, input, init);
} as typeof window.fetch;
