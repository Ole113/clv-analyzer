import type { ParseResult, ParsedRow, BookLine, PickSide } from "../types";

/**
 * Parses the OddsJam Fantasy Optimizer table (fantasy.oddsjam.com/fantasy-odds/<book>).
 *
 * IMPORTANT: this function must stay fully self-contained -- no imports, no module-scope
 * references in its body -- because it is handed to Playwright's page.evaluate() at closing
 * time, which serializes it via Function.prototype.toString(). Every helper is nested inside.
 *
 * Observed layout (2026-09):
 *   TRACK | PLAYER NAME | O/U | STAT | <BOOK> LINE | % CHANCE TO HIT | <sportsbook logo columns...>
 * The PLAYER NAME cell stacks three lines: player, "Team vs Team", "NFL - Sun, Sep 13 : 11:00 AM".
 */
export const parseOddsJamTable = (): ParseResult => {
  const norm = (s: string | null | undefined): string =>
    (s ?? "").replace(/\s+/g, " ").trim();

  const lines = (el: Element | null): string[] => {
    if (!el) return [];
    const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
    return raw
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 0);
  };

  const cellsOf = (row: Element): Element[] => {
    const roleCells = row.querySelectorAll(':scope > [role="cell"], :scope > [role="gridcell"]');
    if (roleCells.length) return Array.from(roleCells);
    return Array.from(row.querySelectorAll(":scope > td, :scope > th"));
  };

  const bookIdFrom = (headerCell: Element | null, index: number): { key: string; label: string | null } => {
    if (headerCell) {
      const img = headerCell.querySelector("img");
      const candidates: (string | null)[] = [
        img?.getAttribute("alt") ?? null,
        img?.getAttribute("title") ?? null,
        headerCell.getAttribute("aria-label"),
        headerCell.getAttribute("data-book"),
        headerCell.getAttribute("title"),
        img?.getAttribute("src") ?? null,
        norm((headerCell as HTMLElement).innerText ?? headerCell.textContent),
      ];
      for (const c of candidates) {
        if (!c) continue;
        const cleaned = c
          .toLowerCase()
          .replace(/\?.*$/, "")
          .replace(/\.(png|svg|jpg|jpeg|webp|gif)$/, "")
          .replace(/^.*\//, "")
          .replace(/[^a-z0-9]/g, "");
        if (cleaned && cleaned.length > 1 && !/^\d+$/.test(cleaned)) {
          const label = norm(c).replace(/^.*\//, "").replace(/\.(png|svg|jpg|jpeg|webp|gif)$/i, "");
          return { key: cleaned, label: label || null };
        }
      }
    }
    return { key: "col-" + index, label: null };
  };

  const parseBookCell = (cell: Element | null, key: string, label: string | null): BookLine => {
    const rawText = norm((cell as HTMLElement | null)?.innerText ?? cell?.textContent ?? "");
    // Strip dollar figures (OddsJam shows suggested stake / handle under some prices).
    const stripped = rawText.replace(/\$\s*[\d,.]+[kKmM]?/g, " ");
    // Signed tokens are american prices; unsigned tokens are the book's line.
    const priceMatch = stripped.match(/[+-]\d{3,}/);
    const lineMatch = stripped.match(/(?:^|[^\d+.-])(\d+(?:\.\d+)?)/);
    return {
      bookKey: key,
      label,
      line: lineMatch ? parseFloat(lineMatch[1]) : null,
      price: priceMatch ? parseInt(priceMatch[0], 10) : null,
      rawText,
    };
  };

  const resolveIso = (timeText: string | null): string | null => {
    if (!timeText) return null;
    if (/live/i.test(timeText)) return null;
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const md = timeText.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2})/);
    const tm = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!md || !tm) return null;
    const month = months[md[1].toLowerCase()];
    if (month === undefined) return null;
    const day = parseInt(md[2], 10);
    let hour = parseInt(tm[1], 10);
    const minute = parseInt(tm[2], 10);
    const mer = (tm[3] ?? "").toUpperCase();
    if (mer === "PM" && hour < 12) hour += 12;
    if (mer === "AM" && hour === 12) hour = 0;
    const now = new Date();
    // Times render without a year; pick the year that puts the game nearest to now.
    let candidate = new Date(now.getFullYear(), month, day, hour, minute, 0, 0);
    const dayMs = 86400000;
    if (candidate.getTime() < now.getTime() - 45 * dayMs) {
      candidate = new Date(now.getFullYear() + 1, month, day, hour, minute, 0, 0);
    } else if (candidate.getTime() > now.getTime() + 320 * dayMs) {
      candidate = new Date(now.getFullYear() - 1, month, day, hour, minute, 0, 0);
    }
    return candidate.toISOString();
  };

  // --- locate the grid -------------------------------------------------------
  const containers: Element[] = [
    ...Array.from(document.querySelectorAll("table")),
    ...Array.from(document.querySelectorAll('[role="table"], [role="grid"]')),
  ];

  let table: Element | null = null;
  let headerCells: Element[] = [];

  for (const c of containers) {
    const headerRow =
      c.querySelector("thead tr") ??
      c.querySelector('[role="row"]:has([role="columnheader"])') ??
      c.querySelector('[role="rowgroup"] [role="row"]');
    if (!headerRow) continue;
    const hCells = Array.from(
      headerRow.querySelectorAll('th, [role="columnheader"]')
    );
    const headerText = hCells.map((h) => norm((h as HTMLElement).innerText ?? h.textContent)).join(" | ").toUpperCase();
    if (headerText.includes("PLAYER") && headerText.includes("STAT")) {
      table = c;
      headerCells = hCells;
      break;
    }
  }

  if (!table) {
    return { ok: false, reason: "OddsJam optimizer table not found", headers: [], rows: [] };
  }

  const headers = headerCells.map((h) => norm((h as HTMLElement).innerText ?? h.textContent));
  const upper = headers.map((h) => h.toUpperCase());
  const findCol = (pred: (h: string) => boolean): number => upper.findIndex(pred);

  const playerCol = findCol((h) => h.includes("PLAYER"));
  const ouCol = findCol((h) => h === "O/U" || h.includes("O/U"));
  const statCol = findCol((h) => h.includes("STAT"));
  const lineCol = findCol((h) => h.includes("LINE"));
  const chanceCol = findCol((h) => h.includes("CHANCE"));
  const knownCols = new Set([playerCol, ouCol, statCol, lineCol]);
  headers.forEach((h, i) => {
    const u = h.toUpperCase();
    if (u.includes("TRACK") || u.includes("CHANCE") || u.includes("CLV")) knownCols.add(i);
  });

  // Verified against the live DOM (2026-09): every book column renders an <img> whose alt is the
  // book name ("FanDuel", "Pinnacle", "PrizePicks (5 or 6 Pick Flex)", "OddsJam Algo Odds"),
  // while the labelled data columns and the unlabelled "Odds" link column never do.
  const bookCols: number[] = [];
  headerCells.forEach((h, i) => {
    if (knownCols.has(i)) return;
    if (!h.querySelector("img")) return;
    bookCols.push(i);
  });

  const bodyRows: Element[] = (() => {
    const tbodyRows = Array.from(table!.querySelectorAll("tbody tr"));
    if (tbodyRows.length) return tbodyRows;
    const roleRows = Array.from(table!.querySelectorAll('[role="row"]'));
    return roleRows.filter((r) => r.querySelector('[role="cell"], [role="gridcell"], td'));
  })();

  const rows: ParsedRow[] = [];

  bodyRows.forEach((rowEl, rowIndex) => {
    const cells = cellsOf(rowEl);
    if (!cells.length) return;

    const playerLines = lines(cells[playerCol] ?? null);
    const player = playerLines[0] ?? null;
    const matchup = playerLines[1] ?? null;
    const meta = playerLines[2] ?? null;

    let sport: string | null = null;
    let gameStartTimeText: string | null = null;
    if (meta) {
      const parts = meta.split(/[•·|]/).map((p) => p.trim()).filter(Boolean);
      sport = parts[0] ?? null;
      gameStartTimeText = parts.slice(1).join(" ") || null;
    }

    let team: string | null = null;
    let opponent: string | null = null;
    if (matchup) {
      const vs = matchup.split(/\s+(?:vs\.?|@|at)\s+/i);
      if (vs.length === 2) {
        team = vs[0].trim();
        opponent = vs[1].trim();
      }
    }

    const sideText = norm((cells[ouCol] as HTMLElement | undefined)?.innerText ?? cells[ouCol]?.textContent);
    const side: PickSide | null = /over/i.test(sideText)
      ? "OVER"
      : /under/i.test(sideText)
        ? "UNDER"
        : null;

    const statMarket = norm((cells[statCol] as HTMLElement | undefined)?.innerText ?? cells[statCol]?.textContent) || null;

    const lineText = norm((cells[lineCol] as HTMLElement | undefined)?.innerText ?? cells[lineCol]?.textContent);
    const lineNum = lineText.match(/-?\d+(\.\d+)?/);
    const takenLine = lineNum ? parseFloat(lineNum[0]) : null;

    const chanceText = norm(
      (cells[chanceCol] as HTMLElement | undefined)?.innerText ?? cells[chanceCol]?.textContent
    );
    const chanceMatch = chanceText.match(/(\d+(?:\.\d+)?)\s*%/);
    const fairProbability = chanceMatch ? parseFloat(chanceMatch[1]) / 100 : null;

    const bookLines: BookLine[] = [];
    for (const ci of bookCols) {
      const cell = cells[ci] ?? null;
      const text = norm((cell as HTMLElement | null)?.innerText ?? cell?.textContent ?? "");
      if (!text) continue;
      const { key, label } = bookIdFrom(headerCells[ci] ?? null, ci);
      bookLines.push(parseBookCell(cell, key, label));
    }

    // OddsJam row ids read "Aaron%20Rodgers%20Over%2014" (player + side + line). Stored as a
    // hint only: the embedded line moves before kickoff, which is the whole point of the tool,
    // so the close-time matcher keys on player + stat + side instead.
    const rawId =
      rowEl.getAttribute("data-prop-id") ??
      rowEl.getAttribute("data-row-id") ??
      rowEl.getAttribute("data-id") ??
      rowEl.getAttribute("id");
    let externalPropId: string | null = null;
    if (rawId) {
      try {
        externalPropId = decodeURIComponent(rawId);
      } catch {
        externalPropId = rawId;
      }
    }

    rows.push({
      rowIndex,
      player,
      team,
      opponent,
      matchup,
      sport,
      statMarket,
      side,
      takenLine,
      fairProbability,
      gameStartTimeText,
      gameStartTimeIso: resolveIso(gameStartTimeText),
      externalPropId,
      externalPlayerId: null,
      bookLines,
      rawText: norm((rowEl as HTMLElement).innerText ?? rowEl.textContent),
    });
  });

  return { ok: true, headers, rows };
};
