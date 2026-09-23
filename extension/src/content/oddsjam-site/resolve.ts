import {
  decodeOddsJamRequest,
  planOddsJamGameStep,
  planOddsJamListingStep,
  type OddsJamListingLink,
  type OddsJamMarketEntry,
  type OddsJamResolveStep,
} from "@clv/shared";

/**
 * Finishes a deep link the board could not answer from the cache, inside the tab the click opened.
 *
 * See `@clv/shared/oddsjam-site.ts` for the whole design and for the written permission this rests
 * on. The short version: the button opens the page that holds the missing piece, with the request
 * riding along in the URL fragment, and this module reads that page and takes the tab the rest of
 * the way -- listing page to game page to game page with the market filter applied.
 *
 * Three properties matter more than anything else here, and the guard test asserts the first two:
 *
 *  - **Nothing runs without a request.** `decodeOddsJamRequest` returning null -- which is every
 *    ordinary visit to oddsjam.com -- means this module does nothing at all and `capture.ts` goes
 *    on passively reading the page as it always did.
 *  - **No request is ever originated.** This navigates the tab it is already in, and that is all:
 *    no `fetch`, no `chrome.tabs`, no timer that reaches OddsJam. The navigations it makes are the
 *    ones a person clicking through the same pages by hand would make.
 *  - **It always terminates.** Every path ends in `finish()`, which strips the request from the URL
 *    so a reload, a back button or a re-render cannot restart it; the "Load more" loop is capped;
 *    and the game-page step refuses to act on a URL that already carries a `?market=`, which is
 *    what stops its own navigation from arriving back in this module as a fresh job.
 */

/** The label OddsJam gives its pagination control, confirmed against the live markup on
 *  2026-09-21: "Load More Games". Anchored, and tolerant of the noun and the verb, so it matches
 *  the control and nothing else on a page full of prose about betting more. */
const LOAD_MORE_TEXT = /^(load|show)\s+more(\s+games)?$/i;

/**
 * The listing's own pagination control, as something that can actually be clicked.
 *
 * Found by its text rather than a class -- the classes here are Tailwind utilities and a
 * module-hashed font name, both of which change on a redeploy, while the label is user-facing. The
 * two-step climb matters: the label is its own `<div class="min-w-0 truncate">Load More Games</div>`
 * nested inside the control, so matching the text finds a plain div, and `closest` is what turns
 * that into the element whose click handler is actually bound. Falling back to the matched element
 * itself covers the control being a bare div with the handler on it.
 *
 * Visibility is checked by measured size rather than `offsetParent`, which is null for a
 * `position:fixed` element and would silently skip a sticky footer control.
 */
function loadMoreButton(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>("button, a, div, span, p")) {
    if (!LOAD_MORE_TEXT.test(el.textContent?.trim() ?? "")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    return el.closest<HTMLElement>("button, a, [role='button']") ?? el;
  }
  return null;
}

/**
 * Every bare `/game/<slug>` link the listing has rendered so far, with the two team names each
 * anchor carries -- the same read `capture.ts` does, and deliberately the same shape, so a slate
 * walked here seeds the cache exactly as browsing it by hand would.
 *
 * Confirmed against the live markup on 2026-09-21: each game card's bare anchor holds exactly two
 * `<p>` elements, away team then home. The card's kickoff ("September 27th • 2:25PM • CBS") is a
 * `<span>`, not a `<p>`, so it cannot be mistaken for a third team; the `?market=moneyline`-style
 * anchors beside it, whose own `<p>`s hold market names and prices, are siblings rather than
 * children and are skipped by the `?` test besides.
 */
function listingLinks(): OddsJamListingLink[] {
  const out: OddsJamListingLink[] = [];
  for (const a of document.querySelectorAll('a[href^="/game/"]')) {
    const href = a.getAttribute("href");
    if (!href || href.includes("?")) continue;
    const slug = href.replace(/^\/game\//, "");
    if (!slug) continue;
    const teams = Array.from(a.querySelectorAll("p"))
      .map((p) => p.textContent?.trim() ?? "")
      .filter((t) => t !== "");
    if (teams.length < 2) continue;
    out.push({ slug, awayTeam: teams[0], homeTeam: teams[1] });
  }
  return out;
}

/** The sport's market vocabulary out of the game page's `__NEXT_DATA__` -- the same blob and the
 *  same shape `capture.ts` reads for the cache, read again here because this tab needs the answer
 *  now rather than on the next click. */
function gameVocabulary(): OddsJamMarketEntry[] {
  const script = document.getElementById("__NEXT_DATA__");
  if (!script?.textContent) return [];
  let data: unknown;
  try {
    data = JSON.parse(script.textContent);
  } catch {
    return [];
  }
  const fallback = (data as { props?: { pageProps?: { fallback?: unknown } } })?.props?.pageProps
    ?.fallback;
  if (!fallback || typeof fallback !== "object") return [];
  const [, result] = Object.entries(fallback as Record<string, unknown>).find(([key]) =>
    /\/markets\?/.test(key)
  ) ?? [];
  const markets = (result as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(markets)) return [];
  return markets.reduce<OddsJamMarketEntry[]>((out, m) => {
    const row = m as Record<string, unknown> | null;
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const label = typeof row?.label === "string" ? row.label.trim() : "";
    if (id && label) out.push({ id, label });
    return out;
  }, []);
}

/**
 * How long to keep looking before giving up and leaving the user where they are.
 *
 * The listing took several real seconds to populate on a live check, and each "Load more" press
 * costs another render, so this is generous. It is a backstop for a page that never renders what is
 * expected, not the normal way a resolve ends -- the normal way is finding the game.
 */
const RESOLVE_TIMEOUT_MS = 30_000;
const POLL_MS = 400;

let navigated = false;
let loadMoreCount = 0;
let timer: number | null = null;

/** Drops the request from the address bar without reloading, so this cannot restart itself and the
 *  user is left with a clean, shareable URL for wherever they ended up. */
function finish(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    // A URL that cannot be rewritten is cosmetic only: `navigated` and the interval being cleared
    // are what actually stop the work.
  }
}

function apply(step: OddsJamResolveStep): void {
  if (step.kind === "done") {
    finish();
    return;
  }
  if (step.kind === "load-more") {
    const button = loadMoreButton();
    if (!button) return; // Gone between planning and acting; the next poll re-plans from scratch.
    loadMoreCount += 1;
    button.click();
    return;
  }
  navigated = true;
  if (timer !== null) clearInterval(timer);
  // `assign`, not `replace`: the page the user's click opened stays in this tab's history, so Back
  // returns them to the listing rather than to the board they came from.
  location.assign(step.url);
}

export function startResolve(): void {
  const request = decodeOddsJamRequest(location.hash);
  if (!request) return;

  const gameSlug = /^\/game\/(.+?)\/?$/.exec(location.pathname)?.[1] ?? null;
  const sportSlug = gameSlug ? null : location.pathname.split("/").filter(Boolean)[0]?.toLowerCase();

  const startedAt = Date.now();
  const tick = () => {
    if (navigated) return;
    if (Date.now() - startedAt > RESOLVE_TIMEOUT_MS) {
      finish();
      return;
    }
    try {
      if (gameSlug) {
        const vocabulary = gameVocabulary();
        // An empty read this early is "not rendered yet", not "no markets"; only a vocabulary that
        // actually arrived is worth planning against, and the timeout above is what ends the wait.
        if (vocabulary.length === 0) return;
        apply(
          planOddsJamGameStep(
            request,
            gameSlug,
            new URLSearchParams(location.search).get("market"),
            vocabulary
          )
        );
        return;
      }
      if (!sportSlug) {
        finish();
        return;
      }
      const links = listingLinks();
      if (links.length === 0) return; // Slate still rendering.
      apply(
        planOddsJamListingStep(request, sportSlug, links, {
          hasLoadMore: loadMoreButton() !== null,
          loadMoreCount,
        })
      );
    } catch (error) {
      console.warn("[CLV Analyzer] OddsJam resolve failed:", error);
      finish();
    }
  };

  tick();
  timer = setInterval(tick, POLL_MS) as unknown as number;
}
