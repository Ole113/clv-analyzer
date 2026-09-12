import { marketFilterKey } from "@clv/shared";

/**
 * Hides excluded markets on PropProfessor's board, from inside the page's own JS world.
 *
 * `world: "MAIN"` for one reason, the same shape as `token-bridge.ts`: the thing that has to be
 * touched only exists in the page's context. PropProfessor renders AG Grid in `ag-layout-normal`
 * with roughly 2,300 rows and ~38 of them in the DOM at a time, each absolutely positioned by a
 * `transform: translateY(...)` AG Grid rewrites as you scroll, inside a container whose height is
 * the *unfiltered* row count times the row height. Hiding a row with CSS from the isolated world
 * therefore cannot work: the row leaves a gap where it was, the scrollbar keeps measuring the rows
 * that are no longer shown, and virtualization keeps rendering a window computed from a row set
 * that no longer matches what is visible. Fighting that by rewriting transforms every frame means
 * reimplementing virtualization against an API that is actively rewriting the same properties.
 *
 * AG Grid already has the feature -- an *external filter* -- and it does all of that correctly:
 * row model, scroll height, virtualization window and pagination all follow. It is only reachable
 * through the grid API, which lives on a React component instance in the page. So this script
 * reaches it, and nothing else:
 *
 *  - It sets only `isExternalFilterPresent` / `doesExternalFilterPass`, which PropProfessor's own
 *    grid options leave undefined (verified live), so nothing of theirs is overwritten.
 *  - It reads `node.data.market` and nothing else off a row, and sends no data anywhere except the
 *    market vocabulary, to this extension's own content script, on the page's own origin.
 *  - It makes no network requests and touches no other page state.
 *
 * If PropProfessor ever starts using external filters itself, this must chain to theirs rather
 * than replace them -- that is the one assumption here that their code could invalidate.
 */

const IN = "clv:pp-grid-filter";
const OUT = "clv:pp-grid-state";

interface GridNode {
  /** AG Grid's own row id. PropProfessor supplies `getRowId`, so it is stable and unique. */
  id?: string | number | null;
  data?: { market?: unknown } | null;
}

interface GridApi {
  setGridOption(key: string, value: unknown): void;
  onFilterChanged(): void;
  getDisplayedRowCount?(): number;
}

/** Keys currently excluded. Empty means "show everything", which is also how a reveal arrives. */
let hidden = new Set<string>();

/**
 * Markets seen in the last filter pass, with counts.
 *
 * Built from the filter callback rather than by walking the row model, because the callback is
 * invoked for exactly the rows that passed PropProfessor's *other* filters (their search box, the
 * Pre-Match/Live toggle, the pick-type selector). A count taken from the full row model would
 * promise to hide 112 bets while the board was showing 9 of them.
 */
let tally = new Map<string, { key: string; label: string; count: number }>();
let published = "";

/**
 * Row ids counted so far in the current pass.
 *
 * AG Grid has no pass-start hook, so the boundary is detected from the rows themselves: a pass
 * visits each row exactly once, so seeing a row id twice means a new pass has begun and the tally
 * starts over. A time gap was tried first and is wrong -- AG Grid runs the predicate over the whole
 * row set *twice* per `onFilterChanged`, back to back within the same tick, which silently doubled
 * every count and made the control promise to hide twice as many bets as it did (measured live:
 * 4,656 callbacks for 2,328 rows).
 */
let seenIds = new Set<string>();

function marketOf(node: GridNode): { key: string; label: string } | null {
  const raw = node?.data?.market;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const key = marketFilterKey(raw);
  return key ? { key, label: raw } : null;
}

function doesPass(node: GridNode): boolean {
  const id = node?.id == null ? null : String(node.id);
  if (id !== null) {
    if (seenIds.has(id)) {
      tally = new Map();
      seenIds = new Set();
    }
    seenIds.add(id);
  }

  const market = marketOf(node);
  if (!market) return true;
  const found = tally.get(market.key);
  if (found) found.count += 1;
  else tally.set(market.key, { key: market.key, label: market.label, count: 1 });
  return !hidden.has(market.key);
}

/**
 * The grid API, off the React component instance that owns the grid.
 *
 * Walked from the DOM rather than held onto: PropProfessor rebuilds the grid when the board
 * changes (switching DFS app, or Pre-Match to Live), and a cached API from the previous one
 * silently stops having any effect -- the same class of bug the checkbox overlay was rewritten to
 * avoid.
 */
function resolveApi(): GridApi | null {
  const root = document.querySelector(".ag-root-wrapper");
  if (!root) return null;
  const fiberKey = Object.keys(root).find((k) => k.startsWith("__reactFiber$"));
  if (!fiberKey) return null;
  let fiber = (root as unknown as Record<string, { stateNode?: { api?: GridApi }; return?: unknown }>)[fiberKey];
  for (let hops = 0; fiber && hops < 40; hops++) {
    const api = fiber.stateNode?.api;
    if (api && typeof api.setGridOption === "function" && typeof api.onFilterChanged === "function") {
      return api;
    }
    fiber = fiber.return as typeof fiber;
  }
  return null;
}

let installedOn: GridApi | null = null;

function sync(force: boolean): void {
  const api = resolveApi();
  if (!api) {
    installedOn = null;
    return;
  }

  const fresh = api !== installedOn;
  if (fresh) {
    // Always "present", even with nothing hidden: the callback is the only place the per-market
    // counts can be taken from, and AG Grid skips it entirely when the filter reports itself
    // absent. Passing every row is the no-op case, so this costs one predicate per row.
    api.setGridOption("isExternalFilterPresent", () => true);
    api.setGridOption("doesExternalFilterPass", doesPass);
    installedOn = api;
  }
  if (fresh || force) api.onFilterChanged();
}

function publish(): void {
  const markets = [...tally.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const payload = JSON.stringify(markets);
  if (payload === published) return;
  published = payload;
  window.postMessage({ source: OUT, markets }, window.location.origin);
}

window.addEventListener("message", (event) => {
  // Same-page, same-origin only -- `window.message` is receivable by anything on the page, and
  // this one changes what the board shows.
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data as { source?: unknown; hidden?: unknown } | null;
  if (!data || data.source !== IN || !Array.isArray(data.hidden)) return;

  const next = new Set(data.hidden.filter((k): k is string => typeof k === "string"));
  const changed = next.size !== hidden.size || [...next].some((k) => !hidden.has(k));
  hidden = next;
  sync(changed);
});

// Cheap, and the only way to notice a grid that was rebuilt under us or a row set that arrived
// after the last pass. `sync` is a no-op once the options are installed on the live API.
setInterval(() => {
  sync(false);
  publish();
}, 700);
sync(false);
