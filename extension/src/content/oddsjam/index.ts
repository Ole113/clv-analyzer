import { parseOddsJamTable } from "@clv/shared";
import { startCapture, type SiteAdapter } from "../shared/inject";

/**
 * OddsJam renders a plain <table>, so the tracker really is an extra column: a <th> in the header
 * and a <td> per row, inserted first.
 *
 * It is deliberately separate from OddsJam's own "TRACK" checkbox (which opens their bet-slip /
 * parlay builder). This adapter never reads or clicks that column -- it only touches nodes it
 * created itself.
 */
const HEAD_MARK = "data-clv-head";

function table(): HTMLTableElement | null {
  const tables = Array.from(document.querySelectorAll("table"));
  return (
    tables.find((t) => {
      const header = t.querySelector("thead tr");
      const text = (header?.textContent ?? "").toUpperCase();
      return text.includes("PLAYER") && text.includes("STAT");
    }) ?? null
  );
}

const adapter: SiteAdapter = {
  site: "ODDSJAM",

  fantasyBook() {
    const match = location.pathname.match(/\/fantasy-odds\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "unknown";
  },

  parse: parseOddsJamTable,

  container() {
    return table();
  },

  rows() {
    const t = table();
    if (!t) return [];
    return Array.from(t.querySelectorAll("tbody tr")).map((el) => {
      const raw = el.getAttribute("id");
      let key: string | null = null;
      if (raw) {
        try {
          key = decodeURIComponent(raw);
        } catch {
          key = raw;
        }
      }
      return { el, key };
    });
  },

  injectHeader() {
    const headerRow = table()?.querySelector("thead tr");
    if (!headerRow || headerRow.querySelector(`[${HEAD_MARK}]`)) return;
    const th = document.createElement("th");
    th.setAttribute(HEAD_MARK, "1");
    th.className = "clva-cell clva-head";
    th.textContent = "CLV";
    headerRow.insertBefore(th, headerRow.firstChild);
  },

  mount(row) {
    let cell = row.querySelector<HTMLTableCellElement>("td.clva-cell");
    if (!cell) {
      cell = document.createElement("td");
      cell.className = "clva-cell";
      row.insertBefore(cell, row.firstChild);
    }
    return cell;
  },
};

startCapture(adapter);
