import type { ParseResult, ParsedRow, BookLine, PickSide } from "../types";

/**
 * Parses the PropProfessor Fantasy Optimizer grid (propprofessor.com/fantasy).
 *
 * Must stay fully self-contained (see the note in parsers/oddsjam.ts) -- it is serialized into
 * the page by Playwright at closing time.
 *
 * Verified against the live DOM (2026-09). PropProfessor renders AG Grid, not a <table>, which
 * matters in two ways:
 *
 *  1. A logical row is split across several [role="row"] elements (pinned columns + centre
 *     viewport), all sharing one `row-id`. Cells must be merged by row-id or most of the book
 *     columns are missed entirely.
 *  2. Columns carry a stable `col-id` that is the book name ("FanDuel", "Pinnacle", "Kalshi"),
 *     so books are keyed by col-id rather than by column position.
 *
 * The row-id is itself a structured, stable identifier and the best matching key available on
 * either site:
 *   NFL:GAME:Los_Angeles_Rams:San_Francisco_49ers:1789086900:Player_Receiving_Yards:Puka_Nacua_Over_62.5
 *   sport : GAME : team : opponent : kickoff epoch (s) : market : player_side_line
 * The trailing line moves before kickoff, so the close-time matcher keys on everything before it.
 */
export const parsePropProfessorTable = (): ParseResult => {
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

  const bookIdFromHeader = (headerCell: Element | null, colId: string): { key: string; label: string | null } => {
    const img = headerCell?.querySelector("img") ?? null;
    const candidates: (string | null)[] = [
      img?.getAttribute("alt") ?? null,
      img?.getAttribute("title") ?? null,
      headerCell?.getAttribute("aria-label") ?? null,
      colId,
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
        return { key: cleaned, label: norm(c) || null };
      }
    }
    return { key: "col-" + colId, label: colId || null };
  };

  const parseBookCell = (cell: Element | null, key: string, label: string | null, side: PickSide | null): BookLine => {
    const rawText = norm((cell as HTMLElement | null)?.innerText ?? cell?.textContent ?? "");
    // Drop suggested-stake figures ("$111 / $696") before reading numbers.
    const stripped = rawText.replace(/\$\s*[\d,.]+[kKmM]?/g, " ");
    // Signed tokens are american prices ("-114 / -110" = over / under); unsigned is the line.
    const priceTokens: string[] = stripped.match(/[+-]\d{3,}/g) ?? [];
    const lineMatch = stripped.match(/(?:^|[^\d+.-])(\d+(?:\.\d+)?)/);
    const priceIdx = side === "UNDER" && priceTokens.length > 1 ? 1 : 0;
    return {
      bookKey: key,
      label,
      line: lineMatch ? parseFloat(lineMatch[1]) : null,
      price: priceTokens.length ? parseInt(priceTokens[priceIdx], 10) : null,
      rawText,
    };
  };

  // --- locate the grid -------------------------------------------------------
  const grid =
    document.querySelector('[role="grid"], [role="table"]') ??
    (document.querySelector('[role="row"][row-id]')?.closest("div") ?? null);

  if (!grid) {
    return { ok: false, reason: "PropProfessor fantasy grid not found", headers: [], rows: [] };
  }

  const headerCells = Array.from(grid.querySelectorAll('[role="columnheader"]'));
  const headerByColId = new Map<string, Element>();
  for (const h of headerCells) {
    const cid = h.getAttribute("col-id");
    if (cid) headerByColId.set(cid, h);
  }
  const headers = headerCells.map((h) => {
    const cid = h.getAttribute("col-id") ?? "";
    const img = h.querySelector("img");
    return norm(img?.getAttribute("alt") ?? (h as HTMLElement).innerText ?? h.textContent) || cid;
  });

  // Data columns carry a text header; book columns carry a logo. Verified on the live grid.
  const reserved = new Set(["actions", "game", "selection", "value", "stability", "clv"]);
  const isBookCol = (colId: string): boolean => {
    if (reserved.has(colId.toLowerCase())) return false;
    const h = headerByColId.get(colId);
    if (h && h.querySelector("img")) return true;
    return !!h;
  };

  // --- merge the pinned/centre halves of each logical row --------------------
  const rowEls = Array.from(grid.querySelectorAll('[role="row"][row-id]'));
  const order: string[] = [];
  const partsByRowId = new Map<string, Element[]>();
  for (const el of rowEls) {
    const rid = el.getAttribute("row-id");
    if (!rid) continue;
    if (!partsByRowId.has(rid)) {
      partsByRowId.set(rid, []);
      order.push(rid);
    }
    partsByRowId.get(rid)!.push(el);
  }

  const rows: ParsedRow[] = [];

  order.forEach((rowId, rowIndex) => {
    const parts = partsByRowId.get(rowId) ?? [];
    const cellByColId = new Map<string, Element>();
    for (const part of parts) {
      const cells = Array.from(part.querySelectorAll('[role="cell"], [role="gridcell"]'));
      for (const c of cells) {
        const cid = c.getAttribute("col-id");
        if (cid && !cellByColId.has(cid)) cellByColId.set(cid, c);
      }
    }
    if (cellByColId.size === 0) return;

    // --- structured identity straight off the row-id -------------------------
    const idParts = rowId.split(":");
    let sport: string | null = null;
    let team: string | null = null;
    let opponent: string | null = null;
    let epochSeconds: number | null = null;
    let marketFromId: string | null = null;
    const unslug = (s: string | undefined): string | null =>
      s ? s.replace(/_/g, " ").trim() || null : null;
    if (idParts.length >= 7 && idParts[1] === "GAME") {
      sport = unslug(idParts[0]);
      team = unslug(idParts[2]);
      opponent = unslug(idParts[3]);
      const epoch = parseInt(idParts[4], 10);
      if (Number.isFinite(epoch) && epoch > 0) epochSeconds = epoch;
      marketFromId = unslug(idParts[5]);
    }

    const selLines = lines(cellByColId.get("selection") ?? null);
    const statMarket = selLines[0] ?? marketFromId;
    const pickLine = selLines[1] ?? unslug(idParts[6]);

    let player: string | null = null;
    let side: PickSide | null = null;
    let takenLine: number | null = null;
    if (pickLine) {
      const m = pickLine.match(/^(.*?)\s+(Over|Under)\s+(-?\d+(?:\.\d+)?)\s*$/i);
      if (m) {
        player = m[1].trim();
        side = /over/i.test(m[2]) ? "OVER" : "UNDER";
        takenLine = parseFloat(m[3]);
      } else {
        player = pickLine;
      }
    }

    const gameLines = lines(cellByColId.get("game") ?? null);
    const matchup = gameLines[0] ?? (team && opponent ? `${team} vs ${opponent}` : null);
    const gameMeta = gameLines[1] ?? null;
    let gameStartTimeText: string | null = null;
    if (gameMeta) {
      const parts2 = gameMeta.split(/[•·|]/).map((p) => p.trim()).filter(Boolean);
      if (!sport && parts2[0]) sport = parts2[0];
      gameStartTimeText = parts2.slice(1).join(" ") || gameMeta;
    }

    const valueText = norm(
      (cellByColId.get("value") as HTMLElement | undefined)?.innerText ??
        cellByColId.get("value")?.textContent
    );
    const valueMatch = valueText.match(/(\d+(?:\.\d+)?)\s*%/);
    const fairProbability = valueMatch ? parseFloat(valueMatch[1]) / 100 : null;

    const bookLines: BookLine[] = [];
    for (const [colId, cell] of cellByColId) {
      if (!isBookCol(colId)) continue;
      const text = norm((cell as HTMLElement).innerText ?? cell.textContent ?? "");
      if (!text) continue;
      const { key, label } = bookIdFromHeader(headerByColId.get(colId) ?? null, colId);
      bookLines.push(parseBookCell(cell, key, label, side));
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
      // The row-id epoch is authoritative; the rendered text is only a fallback label.
      gameStartTimeIso: epochSeconds ? new Date(epochSeconds * 1000).toISOString() : null,
      externalPropId: rowId,
      externalPlayerId: null,
      bookLines,
      rawText: parts.map((p) => norm((p as HTMLElement).innerText ?? p.textContent)).join(" "),
    });
  });

  return { ok: true, headers, rows };
};
