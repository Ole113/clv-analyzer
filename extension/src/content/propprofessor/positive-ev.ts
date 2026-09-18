import { ensureStyles } from "../shared/inject";
import { kellyButton, openKellyModal } from "../shared/kelly-modal";
import { DEFAULT_KELLY_SETTINGS, kellySettings, type KellySettings } from "../shared/kelly-settings";

/**
 * The Kelly button on PropProfessor's +EV page.
 *
 * This page is not a board this extension captures from -- there is no checkbox, no snapshot and no
 * adapter here. It is the one page that already publishes both halves of a Kelly calculation beside
 * every bet (its own price, and a `noVigOdds` that is already de-vigged), so the only thing missing
 * was somewhere to put *your* bankroll and multiplier. Hence a standalone mount rather than another
 * `SiteAdapter`: `startCapture`'s machinery is all about tracking picks, and none of it applies.
 *
 * ## Two views, two shapes
 *
 * The page's Cards/Table toggle is not a restyling of one grid -- the two are built differently and
 * have to be read differently:
 *
 *  - **Table** is a single AG Grid whose cells carry `col-id`, so every number is a direct lookup:
 *    `odds`, `noVigOdds`, `selection`, `market`, and a `kellyDecimal` cell already showing
 *    PropProfessor's own stake, which is exactly where ours belongs.
 *  - **Cards** is a list of ordinary elements, one per bet, each *containing* a small AG Grid for
 *    the book-by-book comparison. The headline numbers live in the card's own markup and the
 *    de-vigged price lives in the inner grid, in a cell that stacks both sides of the market.
 *
 * ## Why so little of this is selector-driven
 *
 * The card markup carries no id, no `data-` attribute and no class of its own -- only Tailwind
 * utilities, which are a styling decision and change when the design does. So the card is found by
 * what it *contains* rather than by what it is called: walk up from each inner grid until reaching
 * an element that also holds a dollar figure, and that element is the card. A layout change leaves
 * that intact; and if it ever does not match, no button is mounted, which is the right way to fail.
 *
 * Every value is re-read from the DOM at click time, never captured when the button is mounted. AG
 * Grid recycles cells as the page scrolls and paginates, so a button mounted against one bet can
 * find itself inside another's cell moments later -- reading late means it opens with whatever the
 * row says *now*. This is the same class of bug the checkbox overlay in `./index.ts` exists to
 * avoid, solved differently because nothing here needs to persist across a recycle.
 */

/** Marks our button so a re-render cannot end up with two of them in one cell. */
const MARK = "data-clv-kelly";

/** Kept fresh on a slow cadence: the bankroll and multiplier are editable on the dashboard while
 *  this page is open, and the modal should not open with numbers from before that edit. */
let settingsCache: KellySettings = DEFAULT_KELLY_SETTINGS;

const STYLES = `
/* The button sits under a dollar figure the page centres, so it centres itself the same way
   rather than inheriting whatever the surrounding flex row is doing. */
[${MARK}] { margin: 3px auto 0; }
`;

/** The text of one cell, split into the lines it renders -- the +EV page stacks both sides of a
 *  market inside a single cell, so a cell is routinely two values rather than one. */
function cellLines(el: Element | null | undefined): string[] {
  if (!el) return [];
  return ((el as HTMLElement).innerText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function text(el: Element | null | undefined): string {
  return ((el as HTMLElement | null)?.textContent ?? "").trim();
}

/** American odds as written on this page ("+105", "-110"), or null for anything else. */
function parseOdds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^([+-]\d+)$/);
  return match ? Number(match[1]) : null;
}

/** A market and a selection read as one subtitle, skipping whichever half is missing. */
function label(market: string, selection: string): string {
  return [market, selection].filter(Boolean).join(" · ") || "this bet";
}

function open(price: number | null, fairPrice: number | null, subtitle: string): void {
  openKellyModal({ price, fairPrice, label: subtitle, settings: settingsCache });
}

function mount(host: Element, onOpen: () => void): void {
  if (host.querySelector(`[${MARK}]`)) return;
  const button = kellyButton(onOpen);
  button.setAttribute(MARK, "1");
  button.title = "Kelly stake calculator for this bet";
  host.appendChild(button);
}

// --- table view ---------------------------------------------------------------------------------

/**
 * One AG Grid, every value a `col-id` away.
 *
 * The button is resolved back to its own row at click time rather than closing over one, for the
 * recycling reason in the module comment: `button.closest('.ag-row')` is always the row the button
 * is *currently* inside, which is the only row it can honestly be about.
 */
function injectTable(): void {
  for (const cell of document.querySelectorAll('.ag-row[row-id] [col-id="kellyDecimal"]')) {
    const host = cell.firstElementChild ?? cell;
    mount(host, () => {
      const row = host.closest(".ag-row");
      if (!row) return;
      const cellIn = (col: string) => row.querySelector(`[col-id="${col}"]`);
      open(
        parseOdds(text(cellIn("odds"))),
        parseOdds(text(cellIn("noVigOdds"))),
        label(text(cellIn("market")), text(cellIn("selection")))
      );
    });
  }
}

// --- cards view ---------------------------------------------------------------------------------

/** Every leaf element of `card` that is not inside its inner odds grid -- i.e. the card's own
 *  headline markup, which is all of fourteen nodes and easily read by what it says. */
function headlineLeaves(card: Element, grid: Element): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>("*")).filter(
    (el) => el.children.length === 0 && !grid.contains(el) && text(el) !== ""
  );
}

/**
 * The card an inner odds grid belongs to: the nearest ancestor that also shows a stake.
 *
 * Deliberately not a class or structural selector -- see the module comment. The dollar figure is
 * both the thing that identifies the card and the thing the button mounts next to, so a card this
 * cannot find is also a card with nowhere to put a button.
 */
function cardFor(grid: Element): { card: Element; stake: HTMLElement } | null {
  let node: Element | null = grid.parentElement;
  for (let depth = 0; depth < 8 && node; depth += 1) {
    const stake = headlineLeaves(node, grid).find((el) => /^\$[\d,.]+$/.test(text(el)));
    if (stake) return { card: node, stake };
    node = node.parentElement;
  }
  return null;
}

/**
 * The de-vigged price for the side this card is actually about.
 *
 * The inner grid stacks both sides of the market in every cell -- selection cell "Vikings -3.5 /
 * Bears +3.5" against no-vig cell "+322 / -322" -- so taking the first number would price the
 * opposite side of a spread exactly backwards half the time. The selection text is matched to its
 * own line and the same index read across, and anything that does not line up returns null, which
 * opens the field blank rather than confidently wrong.
 */
function fairFromInnerGrid(grid: Element, selection: string): number | null {
  const row = grid.querySelector(".ag-row");
  if (!row || !selection) return null;
  const selections = cellLines(row.querySelector('[col-id="selection"]'));
  const fairs = cellLines(row.querySelector('[col-id="noVigOdds"]'));
  const index = selections.indexOf(selection);
  return index >= 0 ? parseOdds(fairs[index]) : null;
}

function injectCards(): void {
  for (const grid of document.querySelectorAll(".ag-root")) {
    // The table view's own grid is not a card's -- it has the columns this page's cards do not.
    if (grid.querySelector('[col-id="kellyDecimal"]')) continue;
    const found = cardFor(grid);
    if (!found) continue;

    // The stake's own parent, not the stake itself: it is the card's little action column (stake,
    // then the copy-link button), already centred, so the button lands under those as another item
    // rather than inline inside the dollar figure's own text node.
    mount(found.stake.parentElement ?? found.stake, () => {
      const leaves = headlineLeaves(found.card, grid);
      // The card prints exactly one American price of its own; the book-by-book prices are all
      // inside the grid, which these leaves exclude.
      const price = parseOdds(leaves.map(text).find((t) => /^[+-]\d+$/.test(t)));
      // Market above selection, the only two centred lines in the card's middle column.
      const centred = leaves.filter((el) => /text-center/.test(String(el.className)));
      const market = centred.length > 1 ? text(centred[0]) : "";
      const selection = text(centred[centred.length - 1] ?? null);
      open(price, fairFromInnerGrid(grid, selection), label(market, selection));
    });
  }
}

// --- lifecycle ----------------------------------------------------------------------------------

/**
 * Whether the +EV page is the one currently on screen.
 *
 * Checked on every pass rather than once at load, because this script is matched against the whole
 * site instead of the one path it cares about. PropProfessor routes on the client: arriving at the
 * +EV page from anywhere else on the site is not a document load, so a `/positive_ev*` match would
 * simply never fire for anyone who got there by clicking rather than by typing the URL. Matching
 * broadly and deciding here covers both, and covers navigating away again for free.
 */
function onPositiveEv(): boolean {
  return location.pathname.startsWith("/positive_ev");
}

function inject(): void {
  if (!onPositiveEv()) return;
  try {
    // Deliberately not hoisted to load time. `ensureStyles` writes one sheet and then short-circuits
    // on its id, so whichever caller runs first decides what is in it -- and on a Fantasy Optimizer
    // page that has to be `startCapture`'s call, which adds the board's own overlay-lane CSS. Doing
    // it here means this script never gets there first on a page that is not its own.
    ensureStyles(STYLES);
    injectTable();
    injectCards();
  } catch (error) {
    console.warn("[CLV Analyzer] +EV Kelly injection failed:", error);
  }
}

let queued = false;
function schedule(): void {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    inject();
  }, 250);
}

function start(): void {
  void kellySettings().then((next) => {
    settingsCache = next;
  });
  setInterval(() => {
    void kellySettings().then((next) => {
      settingsCache = next;
    });
  }, 60_000);

  inject();
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  // The grid swaps its whole container out on a view toggle or a page change, and a mutation burst
  // can settle before the new rows are laid out; a slow interval is the cheap safety net.
  setInterval(schedule, 4000);
}

start();
