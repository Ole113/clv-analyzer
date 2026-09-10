import { parsePropProfessorTable } from "@clv/shared";
import { startCapture, type SiteAdapter } from "../shared/inject";

/**
 * PropProfessor renders AG Grid. Adding a real column would fight the grid's own column model and
 * width calculations, and a logical row is split across pinned/centre elements anyway. So the
 * checkbox is appended inside the existing pinned "actions" cell -- the same place as the row's
 * other controls -- keyed by the grid's stable row-id.
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

function grid(): Element | null {
  return document.querySelector('[role="grid"], [role="table"]');
}

/**
 * PropProfessor pins a single 36px "actions" column on the left. Sharing that one cell with the
 * site's own control crowded them together and let the checkbox sit on the column border, so the
 * pinned lane is widened by LANE px and the checkbox gets that strip to itself, with its own
 * divider. AG Grid lays the pinned and centre containers out as flex siblings, so widening the
 * pinned side shifts the centre columns across cleanly rather than overlapping them.
 */
// 16px box + 4px on each side, matching OddsJam's `.clva-cell` padding (shared/inject.ts) so the
// checkbox reads as the same size on both boards instead of PP's lane dwarfing OJ's bare <td>.
const LANE = 24;
const PINNED_BASE = 36;
const PINNED_TOTAL = PINNED_BASE + LANE;

const LANE_STYLES = `
.ag-pinned-left-cols-container, .ag-pinned-left-header, .ag-horizontal-left-spacer {
  width: ${PINNED_TOTAL}px !important;
  min-width: ${PINNED_TOTAL}px !important;
  max-width: ${PINNED_TOTAL}px !important;
}
.ag-pinned-left-header .ag-header-cell[col-id="actions"],
[role="cell"][col-id="actions"], [role="gridcell"][col-id="actions"] {
  width: ${PINNED_TOTAL}px !important;
  min-width: ${PINNED_TOTAL}px !important;
  max-width: ${PINNED_TOTAL}px !important;
  display: flex !important;
  align-items: center;
  justify-content: flex-start;
  overflow: hidden;
}
.clva-lane {
  width: ${LANE}px; flex: 0 0 ${LANE}px; height: 100%;
  display: flex; align-items: center; justify-content: center;
  border-right: 1px solid rgba(255, 255, 255, 0.16);
}
.clva-lane + * { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; }
/* Boards with no pinned actions column (plain Dabble) get the lane inside their first cell, which
   is not a fixed-width pinned cell -- so it must not be stretched, only given room. */
[role="cell"]:not([col-id="actions"]) > .clva-lane,
[role="gridcell"]:not([col-id="actions"]) > .clva-lane {
  border-right: none; width: auto; flex: 0 0 auto; padding: 0 4px;
}
`;

/**
 * Whether this board has a pinned "actions" column at all, checked against the grid rather than
 * one row: AG Grid renders each logical row as two DOM halves (pinned-left and centre) that share
 * a row-id, and during scroll the centre half can exist in the DOM briefly before its pinned
 * partner does. Asking the row itself "do you have an actions cell" would then say no and fall
 * through to the first-cell guess below -- which, for the centre half, is a book-price cell
 * (FanDuel, Circa, ...), not the actions lane. Asking the grid instead means the fallback only
 * ever fires on boards that truly have no actions column (plain Dabble), never on a stale half of
 * one that does.
 */
function hasActionsColumn(): boolean {
  return !!grid()?.querySelector('[col-id="actions"]');
}

/**
 * The cell the checkbox lives in.
 *
 * Most boards pin an "actions" column and the lane goes there. The plain Dabble board has no
 * actions column at all -- its columns start at "game" -- so requiring one meant no checkbox was
 * ever created on that board. Falling back to the row's first cell puts the lane in the same
 * visual position without depending on a column that may not exist.
 */
function mountCell(row: Element): HTMLElement | null {
  const actions = row.querySelector<HTMLElement>('[col-id="actions"]');
  if (actions) return actions;
  // This row element doesn't carry the actions cell. On boards that have one elsewhere (the
  // pinned-left half, not yet rendered for this row-id), that's a transient gap to wait out --
  // not a cue to plant the checkbox in whatever cell happens to be first here instead.
  if (hasActionsColumn()) return null;
  const first = row.querySelector<HTMLElement>('[role="cell"], [role="gridcell"]');
  return first ?? null;
}

const adapter: SiteAdapter = {
  site: "PROPPROFESSOR",

  fantasyBook() {
    // The book chips carry no aria-selected or data-state -- only Tailwind class variants. The
    // selected one is the colour outlier (brand purple against the neutral rest), which survives
    // class renames; the brand-class check is a backstop.
    const chips = Array.from(document.querySelectorAll<HTMLElement>("button")).filter((b) => {
      const text = (b.textContent ?? "").trim();
      if (!text || text.length > 24) return false;
      return KNOWN_BOOKS.some(
        (n) => text.toLowerCase() === n.toLowerCase() || text.toLowerCase() === `${n.toLowerCase()} (alt)`
      );
    });
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

  rows() {
    const g = grid();
    if (!g) return [];
    const byRowId = new Map<string, Element>();
    for (const el of Array.from(g.querySelectorAll('[role="row"][row-id]'))) {
      const key = el.getAttribute("row-id");
      if (!key) continue;
      // Prefer the half that owns the mount cell; that is where the checkbox goes.
      if (mountCell(el) || !byRowId.has(key)) byRowId.set(key, el);
    }
    return [...byRowId.entries()].map(([key, el]) => ({ el, key }));
  },

  extraStyles: LANE_STYLES,

  injectHeader() {
    // No-op: the lane is reserved by CSS, and a LANE-wide header cell has no room for a label.
  },

  mount(row) {
    const cell = mountCell(row);
    if (!cell) return null;
    let lane = cell.querySelector<HTMLElement>(".clva-lane");
    if (!lane) {
      lane = document.createElement("div");
      lane.className = "clva-lane";
      cell.insertBefore(lane, cell.firstChild);
    }
    return lane;
  },
};

startCapture(adapter);
