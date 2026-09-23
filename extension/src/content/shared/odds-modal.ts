import {
  isExchange,
  newOddsTerminalRequestId,
  oddsTerminalRequestUrl,
  type ParsedRow,
} from "@clv/shared";
import type {
  OddsLookupLine,
  OddsLookupMessage,
  OddsLookupPick,
  OddsLookupResponse,
  OddsSource,
  OddsTerminalLookupMessage,
} from "./messages";

/**
 * Where a human click on this modal goes when the read matched nothing to point at.
 *
 * A successful read supplies `screenUrl` instead, which opens the screen already filtered to the
 * market, the game and the player -- built from the identifiers the screen itself returned, so it
 * lands on the row this modal is describing rather than on a search box.
 */
const PP_ODDS_SCREEN_URL = "https://www.propprofessor.com/screen";

/**
 * "What is this market priced at right now", shown on the board itself.
 *
 * The dashboard has had this for a while (`server/src/components/odds-preview-modal.tsx`), but the
 * dashboard is the wrong place to ask the question: by the time a pick is on `/bets` it has already
 * been taken. The decision happens on the board, looking at a row, and until now the only way to
 * check the real sportsbook market behind a DFS line was to open PropProfessor's odds screen in
 * another tab and search for the player by hand.
 *
 * Two things this deliberately does not do:
 *
 *  - **It does not compute anything.** The averaging, the sportsbook allowlist and the outlier test
 *    stay in `buildClosingVerdict` on the server, reached through `/api/odds-lookup`. A second
 *    implementation here would drift, and the failure mode of that is two screens quoting different
 *    closing numbers for the same market with no way to tell which is right.
 *  - **It does not read the board it is opened from.** The row's identity comes from the adapter's
 *    own parse (already done for capture); the numbers come from whichever source tab is active,
 *    never from the board. An OddsJam row asking about its market sends nothing to OddsJam.
 *
 * The Odds Terminal tab is the one exception to "everything happens over `chrome.runtime`": it has
 * to call `window.open` **synchronously inside the user's click**, because a tab opened after an
 * `await` is a popup the browser may block. See `load()`.
 */

export const ODDS_MODAL_STYLES = `
.clva-odds-btn {
  appearance: none; width: 16px; height: 16px; padding: 0; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(139,155,176,0.5); border-radius: 4px; background: transparent;
  color: #8b9bb0; cursor: pointer; line-height: 0;
  transition: color 120ms ease, border-color 120ms ease;
}
.clva-odds-btn:hover { color: var(--clva-accent); border-color: var(--clva-accent); }
.clva-odds-btn svg { width: 10px; height: 10px; display: block; }
/* Stacked, never side by side: the column these live in is a fixed 24px lane on one board and a
   hand-inserted <td> on the other, and widening either is what causes the layout complaints this
   project already has. Vertically there is row height to spare -- which is why the gap is 9px and
   not the 4px it started at: at 4px the odds button and the checkbox read as one control and were
   easy to mis-click, and the row is tall enough that the extra 5px costs nothing. */
.clva-stack { display: flex; flex-direction: column; align-items: center; gap: 9px; }

.clva-odds-modal {
  background: #131a23; color: #e6edf6; border: 1px solid #243040; border-radius: 11px;
  padding: 18px 20px; width: min(620px, calc(100vw - 40px));
  max-height: min(84vh, 760px); overflow-y: auto;
  box-shadow: 0 22px 55px rgba(0,0,0,0.65);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
/* Positioned with left/top once dragged, so it must not still be centred by margin: auto -- see
   makeDraggable() below, which sets these to the modal's current on-screen position before
   switching position to fixed. Selector is the marker class alone, not scoped to this modal,
   because the Kelly modal is dragged by the same helper. */
.clva-odds-dragged { position: fixed; margin: 0; }
.clva-odds-head {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 14px;
  cursor: grab; user-select: none; margin: -2px -2px 0; padding: 2px 2px 0;
}
.clva-odds-head:active { cursor: grabbing; }
.clva-odds-head h3 { margin: 0; font-size: 16px; }
.clva-odds-head .clva-sub { color: #8b9bb0; font-size: 13px; margin-top: 2px; }
.clva-odds-head-actions { display: flex; gap: 8px; flex: 0 0 auto; }
.clva-odds-modal button {
  font: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  background: #182231; color: #e6edf6; border: 1px solid #243040;
}
.clva-odds-modal button:disabled { opacity: 0.55; cursor: default; }
.clva-odds-icon-btn {
  padding: 6px 8px; display: inline-flex; align-items: center; justify-content: center;
}
.clva-odds-icon-btn svg { width: 13px; height: 13px; display: block; }

.clva-odds-summary {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; margin: 14px 0 10px;
}
.clva-odds-stat { display: inline-flex; align-items: baseline; gap: 6px; }
.clva-odds-stat i {
  font-style: normal; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  color: #8b9bb0;
}
.clva-odds-stat b { font-size: 15px; font-weight: 600; }
.clva-odds-stat s { text-decoration: none; color: #8b9bb0; font-size: 12px; }
.clva-good { color: #3fb950; }
.clva-bad { color: #f85149; }
/* ".clva-odds-modal .clva-info" rather than plain ".clva-info": this is a real <button> now (for
   working keyboard activation), which also makes it a target of ".clva-odds-modal button" above --
   two classes beats one class + one type selector on specificity, so this still wins regardless of
   which rule comes first in the sheet. */
.clva-odds-modal .clva-info {
  display: inline-flex; align-items: center; justify-content: center; align-self: center;
  width: 13px; height: 13px; padding: 0; border-radius: 50%; border: 1px solid #8b9bb0;
  background: transparent; color: #8b9bb0; font-size: 9px; font-style: italic;
  font-family: Georgia, "Times New Roman", serif; cursor: pointer; line-height: 1; flex: 0 0 auto;
}
.clva-info:hover, .clva-info:focus { color: var(--clva-accent); border-color: var(--clva-accent); }
.clva-info-pop {
  position: fixed; z-index: 2147483003; width: 260px; max-width: calc(100vw - 20px);
  background: #131a23; color: #e6edf6; border: 1px solid #243040; border-radius: 9px;
  padding: 10px 12px; box-shadow: 0 14px 34px rgba(0,0,0,0.55);
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.clva-info-pop strong { display: block; margin-bottom: 4px; font-size: 13px; }

.clva-odds-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
.clva-odds-table th, .clva-odds-table td {
  text-align: left; padding: 6px 8px; border-bottom: 1px solid #1d2633; font-size: 13px;
}
.clva-odds-table th { color: #8b9bb0; font-weight: 500; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.06em; }
.clva-odds-table td.clva-num, .clva-odds-table th.clva-num { text-align: right; font-variant-numeric: tabular-nums; }
.clva-odds-table tr.clva-excluded td { opacity: 0.5; }
.clva-odds-book { display: inline-flex; align-items: center; gap: 7px; }
.clva-odds-book img { width: 16px; height: 16px; border-radius: 3px; object-fit: contain; }
.clva-odds-note { color: #8b9bb0; font-size: 12px; margin: 12px 0 0; }
.clva-odds-note a { color: var(--clva-accent); }
.clva-odds-msg { color: #ff9b95; margin: 18px 0; }
.clva-odds-wait { color: #8b9bb0; margin: 24px 0; text-align: center; }

/* The source tabs. A bottom border rather than a pill row so the strip reads as part of the
   dialog's own chrome and does not compete with the Refresh/Close buttons above it. */
.clva-odds-tabs {
  display: flex; gap: 4px; margin: 12px 0 0; border-bottom: 1px solid #243040;
}
.clva-odds-modal .clva-odds-tab {
  background: transparent; border: 0; border-bottom: 2px solid transparent; border-radius: 0;
  padding: 7px 12px; color: #8b9bb0; font-size: 13px; margin-bottom: -1px;
}
.clva-odds-modal .clva-odds-tab:hover { color: #e6edf6; }
.clva-odds-modal .clva-odds-tab[aria-selected="true"] {
  color: #e6edf6; border-bottom-color: var(--clva-accent);
}
.clva-odds-foot { color: #8b9bb0; font-size: 11px; margin: 10px 0 0; }
`;

/** American odds the way a book writes them. */
function fmtOdds(price: number | null): string {
  if (price === null) return "--";
  return price > 0 ? `+${price}` : `${price}`;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Makes a modal draggable by its header, pinning it to wherever it is on pointerdown and then
 * following the pointer. Presses that land on a header button (Refresh, Close) are ignored so
 * those stay clickable. Returns a teardown for the modal's own close path.
 */
export function makeDraggable(modal: HTMLElement, head: HTMLElement): () => void {
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  const onPointerMove = (e: PointerEvent) => {
    const maxLeft = Math.max(0, window.innerWidth - modal.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - modal.offsetHeight);
    modal.style.left = `${Math.min(Math.max(0, e.clientX - dragOffsetX), maxLeft)}px`;
    modal.style.top = `${Math.min(Math.max(0, e.clientY - dragOffsetY), maxTop)}px`;
  };
  const onPointerUp = () => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  };
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const rect = modal.getBoundingClientRect();
    modal.classList.add("clva-odds-dragged");
    modal.style.left = `${rect.left}px`;
    modal.style.top = `${rect.top}px`;
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  });
  return onPointerUp;
}

function link(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}

/** A circular-arrow glyph, built node by node for the same Trusted-Types reason `oddsButton`
 *  below is: an `innerHTML` assignment is rejected outright on a page that enforces them. */
function refreshIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const arc = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arc.setAttribute("d", "M13.5 8A5.5 5.5 0 1 1 11.6 4");
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M13.5 3v3.5H10");
  svg.append(arc, arrow);
  return svg;
}

/**
 * Whichever info popover is currently open, if any -- there is only ever one info button visible
 * at a time, but a Refresh re-renders `summary()` from scratch, and without this the outgoing
 * button's popover (if it happened to be open) would be orphaned on `document.body` with its
 * document-level listeners still attached forever. Closing the previous one before opening a new
 * one, and force-closing it when the modal itself closes, is what keeps that from ever happening.
 */
let closeActiveInfoPopover: (() => void) | null = null;

/**
 * The little "i" next to a stat -- click to toggle a short explanation.
 *
 * Not a `title` attribute: that is a hover-only tooltip, invisible to anyone on a touchscreen and,
 * on this control specifically, invisible to a click too -- which is exactly the bug this replaces.
 * Mirrors the dashboard's own `Info` component (`server/src/components/info.tsx`): a click toggles
 * a small popover, positioned from the button's own `getBoundingClientRect()` and appended to
 * `document.body` so the modal's `overflow-y: auto` can never clip it.
 */
function infoButton(title: string, body: string): HTMLButtonElement {
  const button = el("button", "clva-info", "i");
  button.type = "button";
  button.setAttribute("aria-label", `${title}: ${body}`);
  button.setAttribute("aria-expanded", "false");

  let pop: HTMLElement | null = null;
  const onDocDown = (e: MouseEvent) => {
    if (pop && !pop.contains(e.target as Node) && e.target !== button) close();
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  function close(): void {
    pop?.remove();
    pop = null;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onDocKey, true);
    if (closeActiveInfoPopover === close) closeActiveInfoPopover = null;
  }
  function open(): void {
    closeActiveInfoPopover?.();
    pop = el("div", "clva-info-pop");
    pop.setAttribute("role", "dialog");
    pop.appendChild(el("strong", undefined, title));
    pop.appendChild(el("div", undefined, body));
    document.body.appendChild(pop);

    const r = button.getBoundingClientRect();
    const width = pop.offsetWidth;
    const left = Math.min(Math.max(10, r.left - 8), window.innerWidth - width - 10);
    const height = pop.offsetHeight;
    const below = window.innerHeight - r.bottom - 8 - 10;
    const flip = height > below && r.top - 8 - 10 > below;
    pop.style.left = `${left}px`;
    pop.style.top = `${flip ? Math.max(10, r.top - 8 - height) : r.bottom + 8}px`;

    button.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onDocKey, true);
    closeActiveInfoPopover = close;
  }
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pop) close();
    else open();
  });
  return button;
}

/** The identity the server needs to find this market, taken from the board's own parse. */
export function pickFromRow(row: ParsedRow): OddsLookupPick {
  return {
    sport: row.sport,
    statMarket: row.statMarket ?? "",
    marketType: row.marketType,
    player: row.player,
    subjectTeam: row.subjectTeam,
    matchup: row.matchup,
    side: row.side,
    takenLine: row.takenLine,
    externalPropId: row.externalPropId,
  };
}

function summary(verdict: NonNullable<NonNullable<OddsLookupResponse["preview"]>["verdict"]>, fetchedAt: string): HTMLElement {
  const wrap = el("div", "clva-odds-summary");

  const stat = (
    label: string,
    value: string,
    sub?: string,
    tone?: "good" | "bad",
    infoTitle?: string
  ) => {
    const s = el("span", "clva-odds-stat");
    s.appendChild(el("i", undefined, label));
    const b = el("b", tone === "good" ? "clva-good" : tone === "bad" ? "clva-bad" : undefined, value);
    s.appendChild(b);
    if (infoTitle) s.appendChild(infoButton(label, infoTitle));
    if (sub) s.appendChild(el("s", undefined, sub));
    wrap.appendChild(s);
  };

  const books = (n: number) => `${n} book${n === 1 ? "" : "s"}`;

  // `atLine` set means `table()` below has rewritten every row to that one number, so these
  // headline stats have to describe that number too -- and the at-line fields are the ones that
  // do. `avgClosingLine`/`avgClosingPrice` are taken over just the books whose *own* main line is
  // already sitting there, which on a board lookup is routinely one book out of nine: the modal
  // read "avg price -110 · 1 book" above a table of nine books quoting the same line, because the
  // -110 was the one book's own number and the other eight were being shown at their alt price.
  // Two different questions, and only this one is the question the table is answering.
  if (verdict.atLine !== null) {
    stat("Line", String(verdict.atLine));
    if (verdict.avgPriceAtLine !== null) {
      stat("Avg price", fmtOdds(verdict.avgPriceAtLine), books(verdict.priceAtLineBookCount));
    }
  } else {
    if (verdict.avgClosingLine !== null) {
      stat("Avg line", verdict.avgClosingLine.toFixed(1), books(verdict.closingBookCount));
    }
    // The reason this modal is worth opening on a whole-number market: the line on a passing-
    // touchdowns prop cannot move off 2.5, so the price is the only thing that ever does.
    if (verdict.avgClosingPrice !== null) {
      stat("Avg price", fmtOdds(verdict.avgClosingPrice), books(verdict.closingPriceBookCount));
    }
  }
  if (verdict.edge !== null) {
    stat(
      "Edge",
      `${verdict.edge > 0 ? "+" : ""}${verdict.edge.toFixed(2)}`,
      undefined,
      verdict.edge > 0 ? "good" : verdict.edge < 0 ? "bad" : undefined,
      "How far the line has moved in your favor (positive) or against you (negative) since you " +
        "took this pick, in line points."
    );
  }

  const when = el("span", "clva-odds-stat");
  when.appendChild(el("s", undefined, `as of ${new Date(fetchedAt).toLocaleTimeString()}`));
  wrap.appendChild(when);
  return wrap;
}

/** The money resting behind an exchange's quote, or "--" for a book that doesn't report one. */
function fmtLiquidity(liquidity: number | null): string {
  if (liquidity === null || liquidity <= 0) return "--";
  return `$${Math.round(liquidity).toLocaleString()}`;
}

/**
 * The book-by-book table.
 *
 * When the field has moved off the row's own number, `atLine` is that number and every line is
 * rewritten to it before rendering: a book's `line`/`price` become the row's own taken line and
 * whatever that book pays there (`priceAtLine`), and a book with nothing to say about that exact
 * number is dropped rather than shown quoting some other line, which is not the bet in front of
 * anyone reading this table. `atLine` is null whenever the field is already sitting on that
 * number, so the common case shows every book's own line/price unchanged.
 */
function table(lines: OddsLookupLine[], atLine: number | null): HTMLElement {
  const rows =
    atLine === null
      ? lines
      : lines
          .map((l) => ({
            ...l,
            line: l.line === atLine ? l.line : l.priceAtLine !== null ? atLine : null,
            price: l.line === atLine ? l.price : l.priceAtLine,
          }))
          // A book quoting nothing at the exact line has nothing to contribute to this table --
          // its own (different) line is not the market anyone here is asking about.
          .filter((l) => l.line !== null);

  // Every book had moved off the row's own line by the time this table was asked to show only
  // that number -- rare, but an empty table with headers and no rows is worse than saying so.
  if (rows.length === 0) {
    return el("p", "clva-odds-msg", `No book is currently quoting a price at ${atLine}.`);
  }

  const showLiquidity = rows.some((l) => isExchange(l.bookKey, l.label));

  const t = el("table", "clva-odds-table");
  const head = el("tr");
  head.appendChild(el("th", undefined, "Book"));
  head.appendChild(el("th", "clva-num", "Line"));
  head.appendChild(el("th", "clva-num", "Price"));
  if (showLiquidity) head.appendChild(el("th", "clva-num", "Liquidity"));
  const thead = el("thead");
  thead.appendChild(head);
  t.appendChild(thead);

  const body = el("tbody");
  for (const line of rows) {
    const tr = el("tr", line.includedInAverage ? undefined : "clva-excluded");
    const name = el("td");
    const box = el("span", "clva-odds-book");
    if (line.logoUrl) {
      const img = el("img");
      img.src = line.logoUrl;
      img.alt = "";
      // A board's own CSP can block an external image outright, and a broken-image glyph next to
      // every book is worse than no logos at all.
      img.addEventListener("error", () => img.remove());
      box.appendChild(img);
    }
    box.appendChild(el("span", undefined, line.label ?? line.bookKey));
    if (!line.includedInAverage) box.appendChild(el("s", undefined, "· not averaged"));
    name.appendChild(box);
    tr.appendChild(name);
    tr.appendChild(el("td", "clva-num", line.line === null ? "--" : String(line.line)));
    tr.appendChild(el("td", "clva-num", fmtOdds(line.price)));
    if (showLiquidity) {
      tr.appendChild(
        el("td", "clva-num", isExchange(line.bookKey, line.label) ? fmtLiquidity(line.liquidity) : "--")
      );
    }
    body.appendChild(tr);
  }
  t.appendChild(body);
  return t;
}

/**
 * The two source tabs, in the order they appear. Odds Terminal is first and loads on open.
 *
 * This modal briefly had one tab. It used to have two, the first of which read PropProfessor's
 * odds screen; that automation is what got the PropProfessor account banned (2026-09), and it is
 * never coming back. Odds Terminal now occupies that first, eager slot -- but reached a completely
 * different way, through a tab the user's own click opens rather than a server-side read with a
 * borrowed session. That difference is the entire point; see `oddsterminal-site/relay.ts`.
 */
const SOURCE_TABS: { source: OddsSource; label: string }[] = [
  { source: "ODDS_TERMINAL", label: "Odds Terminal" },
  { source: "ODDS_API", label: "The Odds API" },
];

/** What one tab is currently showing. Cached per tab for the life of the modal -- see `load`. */
type TabState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "result"; preview: NonNullable<OddsLookupResponse["preview"]> };

/** "3 credits used this month, 497 left" -- the cost of the tab, stated where it is spent. */
function quotaNote(preview: NonNullable<OddsLookupResponse["preview"]>): string | null {
  const parts: string[] = [];
  if (preview.servedFromCache) {
    parts.push("Served from the last minute's cached read, so this click cost no credits");
  }
  const remaining = preview.quota?.remaining;
  if (typeof remaining === "number") {
    parts.push(`${remaining.toLocaleString()} credit${remaining === 1 ? "" : "s"} left this month`);
  }
  return parts.length > 0 ? `${parts.join(" · ")}.` : null;
}

/**
 * Opens the modal and keeps it in sync with its own requests.
 *
 * Requests are tagged, so a Refresh fired while the first read is still in flight cannot be
 * overwritten by the older answer landing second -- the same guard the dashboard modal needs, for
 * the same reason.
 */
export function openOddsModal(pick: OddsLookupPick, label: string): void {
  const scrim = el("div", "clva-scrim");
  const modal = el("div", "clva-odds-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", `Current odds for ${label}`);

  const head = el("div", "clva-odds-head");
  const titles = el("div");
  titles.appendChild(el("h3", undefined, "Current odds"));
  titles.appendChild(el("div", "clva-sub", label));
  head.appendChild(titles);

  const actions = el("div", "clva-odds-head-actions");
  const refresh = el("button", "clva-odds-icon-btn");
  refresh.type = "button";
  refresh.title = "Refresh";
  refresh.setAttribute("aria-label", "Refresh odds");
  refresh.appendChild(refreshIcon());
  const close = el("button", undefined, "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  actions.append(refresh, close);
  head.appendChild(actions);
  modal.appendChild(head);

  // Each tab's own answer, kept for as long as the modal is open so switching back is free -- and,
  // for Odds Terminal, so that switching back does not open a second tab on a gated site.
  const tabs = new Map<OddsSource, TabState>(
    SOURCE_TABS.map(({ source }) => [source, { kind: "idle" } as TabState])
  );
  let active: OddsSource = SOURCE_TABS[0].source;

  const tabStrip = el("div", "clva-odds-tabs");
  tabStrip.setAttribute("role", "tablist");
  const tabButtons = new Map<OddsSource, HTMLButtonElement>();
  for (const { source, label: tabLabel } of SOURCE_TABS) {
    const button = el("button", "clva-odds-tab", tabLabel);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(source === active));
    button.addEventListener("click", () => selectTab(source));
    tabButtons.set(source, button);
    tabStrip.appendChild(button);
  }
  modal.appendChild(tabStrip);

  const content = el("div");
  modal.appendChild(content);
  scrim.appendChild(modal);

  const onPointerUp = makeDraggable(modal, head);

  let requestId = 0;
  const done = () => {
    requestId++; // abandons anything still in flight
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
    onPointerUp();
    closeActiveInfoPopover?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      done();
    }
  };
  close.addEventListener("click", done);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) done();
  });
  // The board underneath has its own row handlers, and on OddsJam a click on a row opens their bet
  // slip. Nothing that happens inside this dialog is any of the board's business.
  scrim.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", onKey, true);

  /** Draws whichever tab is active from `tabs`, without asking the network anything. */
  function render(): void {
    for (const [source, button] of tabButtons) {
      button.setAttribute("aria-selected", String(source === active));
    }
    const state = tabs.get(active) ?? { kind: "idle" };
    refresh.disabled = state.kind === "loading";

    if (state.kind === "idle" || state.kind === "loading") {
      content.replaceChildren(
        el(
          "p",
          "clva-odds-wait",
          active === "ODDS_API"
            ? "Reading The Odds API…"
            : "Reading Odds Terminal in the tab that just opened…"
        )
      );
      return;
    }
    if (state.kind === "error") {
      content.replaceChildren(el("p", "clva-odds-msg", state.reason));
      return;
    }

    const preview = state.preview;
    const wrap = el("div");
    if (!preview.ok || !preview.verdict) {
      wrap.appendChild(
        el("p", "clva-odds-msg", preview.reason ?? "Nothing came back for this market.")
      );
    } else {
      const verdict = preview.verdict;
      wrap.appendChild(summary(verdict, preview.fetchedAt));
      if (verdict.closeLines.length === 0) {
        wrap.appendChild(el("p", "clva-odds-msg", "No book columns came back for this market."));
      } else {
        wrap.appendChild(table(verdict.closeLines, verdict.atLine));
      }
      if (verdict.note) wrap.appendChild(el("p", "clva-odds-note", verdict.note));
    }

    const note = el("p", "clva-odds-note");
    if (active === "ODDS_API") {
      // No deep link: The Odds API is an API, not a site, so there is no market page to open. The
      // PropProfessor odds screen is still linked as a manual fallback -- a human clicking it is
      // fine, this modal just never reads it for them any more.
      note.append(
        "Sportsbook lines from ",
        link("The Odds API ↗", "https://the-odds-api.com"),
        ", averaged the same way the Odds Terminal tab is — so the two are directly comparable. ",
        "You can also check ",
        link("PropProfessor's odds screen ↗", PP_ODDS_SCREEN_URL),
        " by hand."
      );
    } else {
      // Deliberately no link to the market: this tab's numbers were read from a tab the user's own
      // click opened, and that tab is still sitting there for them to look at.
      note.append(
        "Sportsbook lines read from Odds Terminal in the tab this modal opened, averaged the same " +
          "way a closing read is."
      );
    }
    wrap.appendChild(note);

    const quota = active === "ODDS_API" ? quotaNote(preview) : null;
    if (quota) wrap.appendChild(el("p", "clva-odds-foot", quota));
    content.replaceChildren(wrap);
  }

  /** Switches tabs, fetching only the first time a tab is shown. */
  function selectTab(source: OddsSource): void {
    if (active === source) return;
    active = source;
    const state = tabs.get(source);
    // The whole point of the lazy second tab: an answer already in hand is shown, never re-bought.
    // On the Odds Terminal tab it also means a second browser tab is not opened on a gated site
    // every time someone flicks back and forth.
    if (state && state.kind !== "idle") {
      render();
      return;
    }
    load(false);
  }

  /**
   * Asks the active source, and parks the answer in that tab.
   *
   * ## Why this function is not `async`
   *
   * The Odds Terminal branch calls `window.open` on the very first line of its path, with no
   * `await` anywhere before it. That is load-bearing, not stylistic: the browser only treats a
   * `window.open` as a user-initiated navigation while it is still inside the click's own task, so
   * a single `await` in front of it turns the lookup into a blocked popup. Everything that can be
   * deferred -- resolving what to fetch, the read itself, the verdict -- happens after the tab is
   * already open, which is also why the worker is told about the request id separately.
   *
   * It is the same constraint `showOddsJamLink` in `inject.ts` is built around, and for once the
   * two really are the same pattern: open the tab on the gesture, let the content script in it
   * finish the job.
   */
  function load(isRefresh: boolean): void {
    const source = active;
    const mine = ++requestId;
    tabs.set(source, { kind: "loading" });
    render();

    const request: Promise<OddsLookupResponse | undefined> =
      source === "ODDS_TERMINAL" ? startOddsTerminalLookup() : askServer(source, isRefresh);

    void (async () => {
      let response: OddsLookupResponse | undefined;
      try {
        response = await request;
      } catch (error) {
        response = {
          ok: false,
          error: error instanceof Error ? error.message : "the extension could not be reached",
        };
      }
      if (requestId !== mine) return;

      tabs.set(
        source,
        !response?.ok || !response.preview
          ? { kind: "error", reason: response?.error ?? "Could not read the odds." }
          : { kind: "result", preview: response.preview }
      );
      // Only redraw if this is still the tab being looked at: an answer that landed after the user
      // switched away belongs in `tabs` (it is shown when they switch back) but must not replace
      // whatever is on screen now.
      if (active === source) render();
    })();
  }

  /**
   * The Odds Terminal path: open the tab first, ask second.
   *
   * The id is minted here and travels two ways -- in the opened tab's URL fragment, and to the
   * background worker -- which is what lets the relay in that tab prove it is answering a lookup
   * this extension is actually waiting on. The worker holds this response open until it is.
   */
  function startOddsTerminalLookup(): Promise<OddsLookupResponse | undefined> {
    const lookupId = newOddsTerminalRequestId();
    // Synchronously, inside the click. Nothing may be awaited above this line -- see `load`.
    //
    // The return value is deliberately ignored, and that is not laziness. `window.open` returns
    // **null whenever `noopener` is set**, by specification: the opener relationship is severed, so
    // there is no handle to hand back. Treating that null as "the pop-up was blocked" -- which this
    // did at first -- meant every single lookup reported a blocked pop-up while the tab it had just
    // opened sat there perfectly fine, and, far worse, returned early so the worker was never told
    // the request id existed. The relay would then ask about an id nobody was waiting on and be
    // turned away. The feature did not work even once.
    //
    // `noopener` stays. This opens a third-party, account-gated site, and handing that page a
    // `window.opener` reference back to the board is not worth trading for a diagnostic. A pop-up
    // that really is blocked is caught by the worker's timeout, which names it as a likely cause.
    window.open(oddsTerminalRequestUrl(lookupId), "_blank", "noopener");
    return chrome.runtime.sendMessage({
      type: "clv:odds-terminal-lookup",
      requestId: lookupId,
      pick,
    } satisfies OddsTerminalLookupMessage);
  }

  /** The Odds API path: one round trip through the server, exactly as it has always been. */
  function askServer(
    source: OddsSource,
    isRefresh: boolean
  ): Promise<OddsLookupResponse | undefined> {
    return chrome.runtime.sendMessage({
      type: "clv:odds-lookup",
      pick: { ...pick, refresh: isRefresh, source },
    } satisfies OddsLookupMessage);
  }

  refresh.addEventListener("click", () => load(true));
  document.body.appendChild(scrim);
  load(false);
}

/** The little button that opens it, sized to the checkbox so the column gets no wider. */
export function oddsButton(onOpen: () => void): HTMLButtonElement {
  const button = el("button", "clva-odds-btn");
  button.type = "button";
  button.title = "Current sportsbook odds for this market";
  button.setAttribute("aria-label", "Current sportsbook odds for this market");
  // A bar chart rather than a word: at 16px there is room for a glyph and nothing else, and this
  // one reads as "lines and prices" without competing with the board's own controls.
  //
  // Built node by node rather than assigned as `innerHTML`, because a site running Trusted Types
  // rejects an innerHTML assignment outright -- even from an isolated-world content script, and
  // even for a constant string like this one. A button that throws on creation would take the whole
  // injection pass down with it.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 10V7M6 10V3M10 10V5");
  svg.appendChild(path);
  button.appendChild(svg);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen();
  });
  return button;
}
