/**
 * Closing lines from PropProfessor's odds screen.
 *
 * Why this exists: the old closing read re-opened the Fantasy Optimizer, a board that only lists
 * props which *still have edge*. A genuinely +EV pick has by definition moved, so it is gone from
 * that board by kickoff -- and the read then recorded "not found", which was scored as UNAVAILABLE
 * and dropped from every aggregate. The tool was discarding precisely its best evidence. The odds
 * screen lists every market whether or not any edge remains, so it can actually answer the
 * question.
 *
 * This module is deliberately pure: no DOM, no `chrome`, no `fetch`. The screen is a plain JSON
 * endpoint, so unlike the board parsers (which are stringified into the page by
 * `chrome.scripting.executeScript` and therefore may not import anything) this code is an ordinary
 * module and is unit-tested in Node against saved responses in `__fixtures__/`.
 *
 * ## The response shape, as observed
 *
 *   game_data: [{ gameId, start, league, homeTeam, awayTeam, market, participant, defaultKey,
 *                 selections: { "<line>" | "null": { selection1, selectionType1, line1,
 *                                                    selection2, selectionType2, line2,
 *                                                    odds: { "<Book>": { odds1, odds2 } } } } }]
 *
 * Side 1 is Over (or the home team on a game market); side 2 is Under (or the away team).
 *
 * Two traps in real data, both load-bearing here:
 *
 *  1. A selection key of `"null"` does NOT always mean "no line". On player props it is used for a
 *     book whose line is recorded only in the selection *text* -- `"Tiafoe Over 5.5"` with
 *     `line1: null` and key `"null"`. Skipping null keys silently drops that book, and in the
 *     observed data the dropped book was BetMGM, a real sportsbook that belongs in the average.
 *  2. `line1` and `line2` are equal on props but must NOT be assumed equal in general: a point
 *     spread quotes +7 to one team and -7 to the other in the same selection.
 */

import { normalizeBookKey } from "../books";
import type { ClosingWorkItem, MarketType, ParseResult, ParsedRow, PickSide } from "../types";
import { resolveClosingMarket } from "../markets";

/** The screen's own backend. A different subdomain from the www host the content scripts run on. */
export const PROPPROFESSOR_SCREEN_ENDPOINT = "https://backend.propprofessor.com/screen";
/** Where a human would go to see the same numbers, stored as the verdict's provenance link. */
export const PROPPROFESSOR_SCREEN_PAGE = "https://www.propprofessor.com/screen";

export interface ScreenReadPlan {
  url: string;
  /** Exactly the body the site's own page sends; see the fixtures' `_request`. */
  body: {
    market: string;
    league: string;
    games: string[];
    participants: string[];
    books: string[];
    is_live: boolean;
    userState: string;
  };
  /** The market name as the *pick* spells it, kept so parsed rows speak the caller's vocabulary. */
  requestedStatMarket: string;
  marketType: MarketType;
}

export interface UnplannableScreenRead {
  /** `noEquivalent` is terminal and blameless; `unmapped` is a gap in our alias table. */
  kind: "noEquivalent" | "unmapped" | "wrongSite";
  reason: string;
}

/**
 * What to ask the screen for, or why this pick cannot be asked about.
 *
 * `item.pageUrl` is deliberately never consulted. It records the board the pick was *captured* on,
 * which for an OddsJam pick is an oddsjam.com URL -- and because it used to take precedence over
 * the board map, dropping OddsJam from that map alone would not have stopped the automated traffic.
 * Provenance and read-target are separate concerns, and the read target here is always PropProfessor
 * regardless of where the pick came from.
 */
export function planScreenRead(
  item: Pick<ClosingWorkItem, "sport" | "statMarket" | "marketType">,
  userState = "ut"
): ScreenReadPlan | UnplannableScreenRead {
  const resolved = resolveClosingMarket(item.sport, item.statMarket, item.marketType);
  if (!resolved.ok) return { kind: resolved.kind, reason: resolved.detail };

  return {
    url: PROPPROFESSOR_SCREEN_ENDPOINT,
    body: {
      market: resolved.market,
      league: resolved.league,
      // Empty filters on purpose: one request per (league, market) answers every pick on that
      // market at once, and filtering server-side by a participant name spelled differently from
      // ours would return nothing at all rather than a near miss we could still resolve.
      games: [],
      participants: [],
      books: [],
      is_live: false,
      userState,
    },
    requestedStatMarket: item.statMarket,
    marketType: item.marketType,
  };
}

// --- response shape (validated defensively; this is someone else's API) ---------------------

interface RawOdds {
  book?: unknown;
  odds1?: unknown;
  odds2?: unknown;
}

interface RawSelection {
  selection1?: unknown;
  selection2?: unknown;
  selectionType1?: unknown;
  selectionType2?: unknown;
  selection1Id?: unknown;
  selection2Id?: unknown;
  line1?: unknown;
  line2?: unknown;
  odds?: Record<string, RawOdds>;
}

interface RawGameDatum {
  id?: unknown;
  gameId?: unknown;
  start?: unknown;
  league?: unknown;
  leagueName?: unknown;
  homeTeam?: unknown;
  awayTeam?: unknown;
  isLive?: unknown;
  market?: unknown;
  participant?: unknown;
  defaultKey?: unknown;
  selections?: Record<string, RawSelection>;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/** American odds as a 0-1 probability, vig included. */
function impliedProbability(price: number): number {
  return price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
}

/** Pulls the number off the end of a selection label, e.g. "Tiafoe Over 5.5" -> 5.5. */
function trailingNumber(label: string | null): number | null {
  if (!label) return null;
  const m = label.match(/(-?\d+(?:\.\d+)?)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * The line this selection quotes for one side.
 *
 * Order matters and is driven by the two traps in the header comment: the side's own `line` field
 * is authoritative when present (it is the only thing that distinguishes +7 from -7 on a spread),
 * the numeric selection key is next, and the trailing number in the selection text is the last
 * resort that rescues the `"null"`-keyed BetMGM rows.
 */
function lineForSide(sel: RawSelection, side: 1 | 2, key: string): number | null {
  const own = num(side === 1 ? sel.line1 : sel.line2);
  if (own !== null) return own;
  const fromKey = key === "null" ? null : Number(key);
  if (fromKey !== null && Number.isFinite(fromKey)) return fromKey;
  return trailingNumber(str(side === 1 ? sel.selection1 : sel.selection2));
}

/**
 * How near even money a quote has to be, in implied probability, to read as a real market rather
 * than a stray order. 0.2 is roughly -400/+400 -- comfortably wider than any main line on a player
 * prop, so this only ever fires on quotes that were never a serious price.
 */
const NEAR_MARKET_MIN_PROB = 0.2;

interface BookMainLine {
  label: string;
  line: number | null;
  /** The taken side's price where the book quotes it. Null is normal and not disqualifying. */
  price: number | null;
  /** False when even this book's best selection is priced nowhere near a real market. */
  nearMarket: boolean;
  /** Every distinct line this book was seen quoting, so alt-line collapsing stays auditable. */
  selectionsSeen: number[];
}

/**
 * Rebuilds each book's own main line across the selection list.
 *
 * The optimizer used to show every book's line side by side in one row. The screen instead splits a
 * player's market into one selection per line, with a different set of books under each -- so a
 * naive read of any single selection sees only the handful of books quoting that exact number.
 *
 * Reconstructing the optimizer's shape keeps `edge` denominated in line units and leaves every
 * downstream convention (Over/Under direction, spread sign, moneyline price handling) untouched.
 *
 * A book's main line is the selection where its price is least lopsided, because that is what
 * distinguishes a real market from an alt: a book hanging Over 9.5 at -400 is not quoting 9.5 as
 * its number, it is selling a near-certainty. Where the book prices both sides, the balance between
 * them is the better signal; where it prices only one, distance from even money is all there is,
 * and such a quote loses ties to a two-sided one.
 *
 * A book is kept whenever it quotes the selection *at all*, even if the side actually taken has no
 * price. The line is a property of the market, not of one side of it -- a book hanging Over 21.5 is
 * quoting 21.5 to an Under bettor too -- and CLV here is measured in line units, so the price only
 * ever serves to identify which selection is the book's real number. Requiring a price on the taken
 * side is not a stricter test, just a lossy one: in the captured Xavier Robinson market only 10 of
 * 18 books carry an Under price, and demanding one drops DraftKings, Fanatics and theScore out of
 * the closing average despite all three plainly quoting the market.
 */
function mainLineByBook(
  selections: Record<string, RawSelection>,
  side: 1 | 2
): Map<string, BookMainLine> {
  const best = new Map<string, { entry: BookMainLine; lopsidedness: number }>();

  for (const [key, sel] of Object.entries(selections ?? {})) {
    if (!sel || typeof sel !== "object") continue;
    const line = lineForSide(sel, side, key);
    const odds = sel.odds;
    if (!odds || typeof odds !== "object") continue;

    for (const [bookName, quote] of Object.entries(odds)) {
      if (!quote || typeof quote !== "object") continue;
      const price = num(side === 1 ? quote.odds1 : quote.odds2);
      const other = num(side === 1 ? quote.odds2 : quote.odds1);
      if (price === null && other === null) continue;

      // Deliberately computed from both prices rather than the taken side's, so the OVER and the
      // UNDER row agree on which selection is a given book's main line.
      const lopsidedness =
        price === null || other === null
          ? Math.abs(impliedProbability((price ?? other) as number) - 0.5) + 1
          : Math.abs(impliedProbability(price) - impliedProbability(other));

      // Whether this quote looks like a real two-sided market at all. Kept alongside the chosen
      // entry so a book can be dropped when even its *best* selection is a stray order.
      const nearMarket = [price, other]
        .filter((p): p is number => p !== null)
        .some((p) => {
          const prob = impliedProbability(p);
          return prob >= NEAR_MARKET_MIN_PROB && prob <= 1 - NEAR_MARKET_MIN_PROB;
        });

      const label = str(quote.book) ?? bookName;
      const existing = best.get(bookName);
      if (existing) {
        if (line !== null) existing.entry.selectionsSeen.push(line);
        if (lopsidedness >= existing.lopsidedness) continue;
        existing.lopsidedness = lopsidedness;
        existing.entry = { ...existing.entry, label, line, price, nearMarket };
      } else {
        best.set(bookName, {
          lopsidedness,
          entry: { label, line, price, nearMarket, selectionsSeen: line !== null ? [line] : [] },
        });
      }
    }
  }

  const out = new Map<string, BookMainLine>();
  for (const [bookName, { entry }] of best) {
    entry.selectionsSeen = [...new Set(entry.selectionsSeen)].sort((a, b) => a - b);
    out.set(bookName, entry);
  }
  return out;
}

function buildRow(
  datum: RawGameDatum,
  plan: ScreenReadPlan,
  side: 1 | 2,
  rowIndex: number
): ParsedRow | null {
  const selections = datum.selections;
  if (!selections || typeof selections !== "object") return null;

  const books = mainLineByBook(selections, side);
  if (books.size === 0) return null;

  const home = str(datum.homeTeam);
  const away = str(datum.awayTeam);
  const participant = str(datum.participant);
  const isGameMarket = plan.marketType === "MONEYLINE" || plan.marketType === "SPREAD";

  // The selection labels are the team names on a game market and "<player> Over <line>" on a prop.
  const firstSel = Object.values(selections)[0] as RawSelection | undefined;
  const selectionName = str(side === 1 ? firstSel?.selection1 : firstSel?.selection2);
  const selectionType = str(side === 1 ? firstSel?.selectionType1 : firstSel?.selectionType2);

  const pickSide: PickSide | null = isGameMarket
    ? null
    : selectionType?.toLowerCase() === "under"
      ? "UNDER"
      : "OVER";

  const bookLines = [...books.values()]
    // A moneyline's tracked line IS its price, so a book that does not price this team has
    // nothing to contribute; on every other market the line stands on its own.
    .filter((b) => plan.marketType !== "MONEYLINE" || b.price !== null)
    // A prop or spread whose best price is nowhere near even money is not a line anyone is really
    // offering -- typically one resting order on an exchange, where a -1000 quote against a field
    // at -110 can sit untaken indefinitely. Its *line* may look ordinary, so the consensus check
    // downstream would not catch it; the giveaway is the price. Never applied to moneylines, where
    // -1000 is an ordinary price for a heavy favourite.
    .filter((b) => plan.marketType === "MONEYLINE" || b.nearMarket)
    .map((b) => {
      const alts = b.selectionsSeen.filter((l) => l !== b.line);
      return {
        bookKey: normalizeBookKey(b.label) ?? "unknown",
        label: b.label,
        // A moneyline has no number to move, so the price *is* the tracked line -- the same
        // convention the OddsJam parser uses, which keeps computeClv's arithmetic unchanged.
        line: plan.marketType === "MONEYLINE" ? b.price : b.line,
        price: b.price,
        logoUrl: null,
        rawText:
          `${b.line ?? "-"} @ ${b.price ?? "no price this side"}` +
          (alts.length > 0 ? ` (also quoted ${alts.join(", ")})` : ""),
      };
    });

  const usable = bookLines.map((b) => b.line).filter((l): l is number => l !== null);
  const takenLine =
    usable.length > 0
      ? Math.round((usable.reduce((sum, l) => sum + l, 0) / usable.length) * 100) / 100
      : null;

  return {
    rowIndex,
    marketType: plan.marketType,
    player: isGameMarket ? null : (participant ?? selectionName),
    selectionName,
    // On a game market the team carries the pick's identity, exactly as on a spread.
    subjectTeam: isGameMarket ? (selectionName ?? (side === 1 ? home : away)) : null,
    isLive: datum.isLive === true,
    team: home,
    opponent: away,
    matchup: home && away ? `${away} vs ${home}` : null,
    sport: str(datum.league),
    // Deliberately the market name as the *pick* spells it, not PropProfessor's. The alias table
    // asserts the two name one market, so translating here is what lets the shared matcher keep
    // working unchanged -- "Break Points Won" would otherwise never match "Player Breakpoints Won",
    // since neither string contains the other.
    statMarket: plan.requestedStatMarket,
    side: pickSide,
    takenLine,
    // The screen publishes no de-vigged probability of its own, and deriving one here would need
    // both sides at the same line from the same book. Left null rather than guessed; capture-time
    // EV is retained by apply-closing when the close has none.
    fairProbability: null,
    boardEvPercent: null,
    gameStartTimeText: str(datum.start),
    gameStartTimeIso: str(datum.start),
    externalPropId: str(side === 1 ? firstSel?.selection1Id : firstSel?.selection2Id),
    externalPlayerId: null,
    bookLines,
    rawText: JSON.stringify({
      source: "propprofessor-screen",
      ppMarket: str(datum.market),
      gameId: str(datum.gameId),
      defaultKey: str(datum.defaultKey),
      selectionCount: Object.keys(selections).length,
    }),
  };
}

/**
 * Turns a raw `/screen` response into rows the existing matcher and verdict builder already
 * understand.
 *
 * Emits one row per side: a player prop becomes an OVER row and an UNDER row, because
 * `findMatchingRow` identifies a prop by player + stat + side and would otherwise have nothing to
 * compare the side against. A game market becomes one row per team.
 *
 * Never throws -- a malformed payload returns `{ ok: false, reason }` the same way the DOM parsers
 * do, so one bad response cannot take down a closing run.
 */
export function normalizeScreenMarket(raw: unknown, plan: ScreenReadPlan): ParseResult {
  try {
    const body = raw as { game_data?: unknown };
    const data = body?.game_data;
    if (!Array.isArray(data)) {
      return { ok: false, reason: "response had no game_data array", headers: [], rows: [] };
    }

    const rows: ParsedRow[] = [];
    for (const datum of data as RawGameDatum[]) {
      if (!datum || typeof datum !== "object") continue;
      for (const side of [1, 2] as const) {
        const row = buildRow(datum, plan, side, rows.length);
        if (row) rows.push(row);
      }
    }

    return {
      ok: true,
      headers: [plan.body.league, plan.body.market],
      rows,
      reason: rows.length === 0 ? "the market returned no priced selections" : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "could not read the screen response",
      headers: [],
      rows: [],
    };
  }
}
