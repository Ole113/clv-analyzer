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
// 16px box + its 3px side margins + breathing room, so the checkbox never touches the divider.
const LANE = 28;
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
`;

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
      // Prefer the half that owns the actions cell; that is where the checkbox goes.
      const hasActions = !!el.querySelector('[col-id="actions"]');
      if (hasActions || !byRowId.has(key)) byRowId.set(key, el);
    }
    return [...byRowId.entries()].map(([key, el]) => ({ el, key }));
  },

  extraStyles: LANE_STYLES,

  injectHeader() {
    // No-op: the lane is reserved by CSS, and a LANE-wide header cell has no room for a label.
  },

  mount(row) {
    const cell = row.querySelector<HTMLElement>('[col-id="actions"]');
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
