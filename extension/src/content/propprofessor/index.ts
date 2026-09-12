import { parsePropProfessorTable } from "@clv/shared";
import { startCapture, type SiteAdapter } from "../shared/inject";

/**
 * PropProfessor renders AG Grid, which virtualizes both axes: it recycles cell DOM nodes as the
 * grid scrolls horizontally (columns swap in and out), and it can rebuild the whole row/column set
 * when the board itself changes (e.g. switching DFS-app tabs). Two real bugs came from mounting the
 * checkbox inside a cell AG Grid owns: shift+scroll (the usual way to scroll horizontally on
 * Windows) could strand a checkbox on the wrong column when its host cell got recycled, and
 * switching tabs (Dabble -> another board) could leave a stale checkbox behind alongside a new one
 * for what looked like the same row.
 *
 * Both bugs share one cause: the checkbox's continued existence depended on a specific AG Grid DOM
 * node's identity, which AG Grid is free to reuse or destroy without notice. The fix is to stop
 * depending on it. Checkboxes now live in an independent overlay appended to `document.body`,
 * keyed only by the grid's own stable `row-id` -- never by which DOM node currently renders that
 * row -- and positioned every animation frame from that row's live `getBoundingClientRect()`. AG
 * Grid can recycle or rebuild anything it wants; the overlay only cares whether a row-id currently
 * exists on the page, which it re-derives from scratch on every frame.
 */
const KNOWN_BOOKS = [
  "PrizePicks",
  "Underdog",
  "Betr",
  "Dabble",
  "DraftKings6",
  "Sleeper",
  "ParlayPlay",
  "HotStreak",
  "BoomFantasy",
  "Chalkboard",
];

/** Width of the reserved strip beside the grid the checkboxes live in. */
const LANE = 24;
const OVERLAY_ID = "clva-pp-overlay";

function grid(): Element | null {
  return document.querySelector('[role="grid"], [role="table"]');
}

/**
 * The book chips carry no aria-selected or data-state -- only Tailwind class variants -- but their
 * mere presence is also the only reliable signal that this is the Fantasy Optimizer board at all.
 * PropProfessor is a client-routed SPA and the manifest's `/fantasy*` match covers more than just
 * this board (the odds screen -- real sportsbook lines, not DFS picks -- lives under the same
 * prefix), so without this check `grid()` will happily latch onto any AG Grid on the page and
 * inject a checkbox somewhere it doesn't belong.
 */
function boardChips(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("button")).filter((b) => {
    const text = (b.textContent ?? "").trim();
    if (!text || text.length > 24) return false;
    return KNOWN_BOOKS.some(
      (n) => text.toLowerCase() === n.toLowerCase() || text.toLowerCase() === `${n.toLowerCase()} (alt)`
    );
  });
}

/** Every logical row currently on the page, deduped by row-id (AG Grid splits pinned/centre
 *  halves of one row across two DOM elements sharing an id; either half's rect is the same). */
function currentRows(): { el: Element; key: string }[] {
  const g = grid();
  if (!g) return [];
  const byRowId = new Map<string, Element>();
  for (const el of Array.from(g.querySelectorAll('[role="row"][row-id]'))) {
    const key = el.getAttribute("row-id");
    if (key && !byRowId.has(key)) byRowId.set(key, el);
  }
  return [...byRowId.entries()].map(([key, el]) => ({ el, key }));
}

function overlayHost(): HTMLElement {
  let host = document.getElementById(OVERLAY_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = OVERLAY_ID;
    document.body.appendChild(host);
  }
  return host;
}

/** row-id -> its checkbox's slot. The slot persists for as long as the row-id does, regardless of
 *  how many times AG Grid recycles or rebuilds the DOM node that currently renders that row. */
const slots = new Map<string, HTMLElement>();

function positionSlot(slot: HTMLElement, row: Element, gridRect: DOMRect): void {
  const r = row.getBoundingClientRect();
  const visible = r.height > 0 && r.bottom > gridRect.top && r.top < gridRect.bottom;
  slot.style.top = `${r.top}px`;
  // The reserved strip sits just outside the grid's own (margin-shifted) left edge -- see the
  // `[role="grid"]` margin rule below -- so this stays put across horizontal scroll, since that
  // scroll never moves the grid's own bounding box, only its internal column layout.
  slot.style.left = `${gridRect.left - LANE}px`;
  slot.style.height = `${r.height}px`;
  slot.style.visibility = visible ? "visible" : "hidden";
}

/** Repositions every live slot and drops any whose row no longer exists. Runs every animation
 *  frame: cheap (a handful of `getBoundingClientRect()` calls), and correctness here matters more
 *  than the two AG-Grid-recycling bugs this replaces ever did, so it does not wait for a debounced
 *  MutationObserver pass the way the checkbox-creation cycle in shared/inject.ts does. */
function reposition(): void {
  const g = boardChips().length > 0 ? grid() : null;
  if (!g) {
    for (const slot of slots.values()) slot.remove();
    slots.clear();
    return;
  }
  const gridRect = g.getBoundingClientRect();
  const seen = new Set<string>();
  for (const { el, key } of currentRows()) {
    seen.add(key);
    const slot = slots.get(key);
    if (slot) positionSlot(slot, el, gridRect);
  }
  for (const [key, slot] of slots) {
    if (!seen.has(key)) {
      slot.remove();
      slots.delete(key);
    }
  }
}

function repositionLoop(): void {
  reposition();
  requestAnimationFrame(repositionLoop);
}
requestAnimationFrame(repositionLoop);

const OVERLAY_STYLES = `
#${OVERLAY_ID} { position: fixed; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483000; }
.clva-slot {
  position: fixed !important; box-sizing: border-box !important; overflow: hidden !important;
  width: ${LANE}px !important; min-width: ${LANE}px !important; max-width: ${LANE}px !important;
  pointer-events: auto; display: flex !important; align-items: center; justify-content: center;
}
/* Reserves the strip the slots render into. A plain margin (not width/padding on some AG-Grid-
   internal element) so this works identically on every board layout without depending on which
   columns a given board happens to pin.
   KNOWN ISSUE (plain Dabble board, no pinned actions column): reported as a checkbox that renders
   too wide and covers the board's own "add to slip" control. Not yet reproduced live -- one
   plausible mechanism is that this margin only shifts the grid's own box, not a same-site control
   that is itself fixed/sticky to the viewport rather than laid out inside the grid, so the two end
   up occupying the same screen position instead of the checkbox landing in genuinely empty space.
   If this still happens after reloading the extension, the fix likely needs to stop reserving
   space this way entirely rather than adjusting the offset -- flag it with a screenshot. */
[role="grid"] { margin-left: ${LANE}px; }
`;

const adapter: SiteAdapter = {
  site: "PROPPROFESSOR",

  // Not the Fantasy Optimizer (e.g. the odds screen) when no board chip is on the page at all.
  isActive() {
    return boardChips().length > 0;
  },

  fantasyBook() {
    // The selected chip carries no aria-selected or data-state -- only Tailwind class variants.
    // It's the colour outlier (brand purple against the neutral rest), which survives class
    // renames; the brand-class check is a backstop.
    const chips = boardChips();
    if (chips.length === 0) return "unknown";

    const slug = (el: HTMLElement) =>
      (el.textContent ?? "")
        .trim()
        .toLowerCase()
        .replace(/[()]/g, "")
        .replace(/\s+/g, "-");

    const branded = chips.find((c) => /custompurple/i.test(c.className));
    if (branded) return slug(branded);

    const counts = new Map<string, number>();
    const colors = chips.map((c) => {
      const bg = getComputedStyle(c).backgroundColor;
      counts.set(bg, (counts.get(bg) ?? 0) + 1);
      return bg;
    });
    let modal = "";
    let modalCount = -1;
    for (const [bg, n] of counts) {
      if (n > modalCount) {
        modal = bg;
        modalCount = n;
      }
    }
    const selectedIndex = colors.findIndex((bg) => bg !== modal);
    return selectedIndex >= 0 ? slug(chips[selectedIndex]) : "unknown";
  },

  parse: parsePropProfessorTable,

  container() {
    return grid();
  },

  rows: currentRows,

  extraStyles: OVERLAY_STYLES,

  injectHeader() {
    // No-op: the lane is reserved by CSS, and a LANE-wide header cell has no room for a label.
  },

  mount(row) {
    const key = row.getAttribute("row-id");
    if (!key) return null;
    let slot = slots.get(key);
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "clva-slot";
      overlayHost().appendChild(slot);
      slots.set(key, slot);
    }
    const g = grid();
    if (g) positionSlot(slot, row, g.getBoundingClientRect());
    return slot;
  },
};

startCapture(adapter);
