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

import { bookLogoUrl, normalizeBookKey } from "../books";
import type { ClosingWorkItem, MarketType, ParseResult, ParsedRow, PickSide } from "../types";
import { resolveClosingMarket } from "../markets";
import { devigTwoWay } from "../devig";
import { pickMainLines, type BookMainLine, type BookQuote } from "./main-line";

/** The screen's own backend. A different subdomain from the www host the content scripts run on. */
export const PROPPROFESSOR_SCREEN_ENDPOINT = "https://backend.propprofessor.com/screen";
/** Where a human would go to see the same numbers, stored as the verdict's provenance link. */
export const PROPPROFESSOR_SCREEN_PAGE = "https://www.propprofessor.com/screen";

/**
 * A link to the odds screen already filtered to one market, one game and one player.
 *
 * The screen does read its filters from the query string -- `league`, `market`, `game` and
 * `participant` -- which is worth stating plainly because this codebase concluded the opposite once
 * and wrote it down (see `oddsScreenUrlFor` in the server's queries.ts). That attempt tried
 * `?sport=`, which the page ignores; these four are the names it actually reads, verified on a cold
 * load rather than on a click-through, since client-side routing would have hidden the difference.
 *
 * Nothing here is constructed or guessed. `game` is the screen's own `gameId` and `participant` its
 * own spelling of the player, both read straight back out of the response being linked to -- which
 * matters, because our spelling of either is routinely not theirs ("LA Rams", "Alexander Zverev"),
 * and a filter that does not match returns an empty screen rather than a near miss. A caller with
 * no gameId gets the bare screen, which is exactly where the link pointed before.
 */
export function screenPageUrl(target: {
  league: string | null;
  market: string | null;
  gameId?: string | null;
  participant?: string | null;
}): string {
  if (!target.gameId || !target.league || !target.market) return PROPPROFESSOR_SCREEN_PAGE;
  const params = new URLSearchParams({
    market: target.market,
    game: target.gameId,
    league: target.league,
  });
  // Absent on a game market, where the fixture is the whole selection and the screen expects no
  // participant at all -- sending an empty one filters to nothing.
  if (target.participant) params.set("participant", target.participant);
  return `${PROPPROFESSOR_SCREEN_PAGE}?${params.toString()}`;
}

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
  /** Money resting behind each side. Meaningful on exchanges; most books report a flat 0. */
  liquidity1?: unknown;
  liquidity2?: unknown;
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

/** A market name without its period qualifier: "Total Points - 1st Half" -> "total points". */
function baseMarket(market: string): string {
  return market.split(" - ")[0].trim().toLowerCase();
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
 * Flattens one market's `selections` object into the quote list `pickMainLines` reads.
 *
 * Every trap in the header comment is handled here rather than downstream: the `"null"` selection
 * key, the per-side `line` field, and the one-sided quote. What comes out is shape-identical to
 * what The Odds API's adapter produces, which is what lets both sources share the consensus rule --
 * see `main-line.ts` for why that matters.
 */
function quotesFrom(selections: Record<string, RawSelection>, side: 1 | 2): BookQuote[] {
  const quotes: BookQuote[] = [];
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

      quotes.push({
        bookKey: bookName,
        label: str(quote.book) ?? bookName,
        line,
        price,
        otherSidePrice: other,
        // The taken side's depth, falling back to the other side's when this side is unpriced --
        // the book is still making a market, and reading 0 there would understate it as a dead
        // column.
        liquidity:
          num(side === 1 ? quote.liquidity1 : quote.liquidity2) ??
          num(side === 1 ? quote.liquidity2 : quote.liquidity1),
      });
    }
  }
  return quotes;
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
 * A book is kept whenever it quotes the selection *at all*, even if the side actually taken has no
 * price. The line is a property of the market, not of one side of it -- a book hanging Over 21.5 is
 * quoting 21.5 to an Under bettor too -- and CLV here is measured in line units, so the price only
 * ever serves to identify which selection is the book's real number. Requiring a price on the taken
 * side is not a stricter test, just a lossy one: in the captured Xavier Robinson market only 10 of
 * 18 books carry an Under price, and demanding one drops DraftKings, Fanatics and theScore out of
 * the closing average despite all three plainly quoting the market.
 *
 * Which selection *is* a book's main line is decided by `pickMainLines`; see its own doc comment.
 */
function mainLineByBook(
  selections: Record<string, RawSelection>,
  side: 1 | 2,
  atLine: number | null
): Map<string, BookMainLine> {
  return pickMainLines(quotesFrom(selections, side), atLine);
}

function buildRow(
  datum: RawGameDatum,
  plan: ScreenReadPlan,
  side: 1 | 2,
  rowIndex: number,
  atLine: number | null
): ParsedRow | null {
  const selections = datum.selections;
  if (!selections || typeof selections !== "object") return null;

  const books = mainLineByBook(selections, side, atLine);
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
      const bookKey = normalizeBookKey(b.label) ?? "unknown";
      return {
        bookKey,
        label: b.label,
        // A moneyline has no number to move, so the price *is* the tracked line -- the same
        // convention the OddsJam parser uses, which keeps computeClv's arithmetic unchanged.
        line: plan.marketType === "MONEYLINE" ? b.price : b.line,
        price: b.price,
        // 0 is recorded as 0 rather than collapsed to null: "this book publishes no depth" and
        // "this book has depth we did not read" are different, and only the former is the common
        // case. Downstream weighting treats 0 as "no information", not as "no market".
        liquidity: b.liquidity,
        // This book's own no-vig probability for the side taken, where it priced both sides. The
        // consensus of these is formed downstream rather than here, so that it is taken over
        // exactly the books that survive the sportsbook allowlist and the outlier test -- a
        // pick'em column quoting -119/-119 de-vigs to a meaningless flat 50% and must not be
        // allowed to drag the fair price to the middle.
        fairProbability: devigTwoWay(b.price, b.otherSidePrice),
        // What this book pays at the line the caller is looking at, where it quotes it at all. Sits
        // alongside `line`/`price` rather than replacing them; see the field's own comment.
        priceAtLine: b.priceAtLine,
        // The screen is JSON and ships no images, so unlike the DOM parsers there is no logo to
        // scrape -- it is looked up from the book's name instead. Null for a book we have no
        // domain for, which the tables already render as "name, no icon".
        logoUrl: bookLogoUrl(bookKey, b.label),
        rawText:
          `${b.line ?? "-"} @ ${b.price ?? "no price this side"}` +
          (alts.length > 0 ? ` (also quoted ${alts.join(", ")})` : "") +
          (atLine !== null && b.line !== atLine
            ? `; at ${atLine}: ${b.priceAtLine ?? "not quoted"}`
            : ""),
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
    // The screen publishes no *row-level* de-vigged probability, and there is nothing honest to put
    // here: the raw data does support one (see `fairProbability` on each book line above), but the
    // consensus of those has to be taken after the sportsbook allowlist and the outlier test have
    // run, which happens server-side in buildClosingVerdict. Left null so there is exactly one
    // closing fair probability rather than two that can disagree.
    fairProbability: null,
    boardEvPercent: null,
    gameStartTimeText: str(datum.start),
    gameStartTimeIso: str(datum.start),
    externalPropId: str(side === 1 ? firstSel?.selection1Id : firstSel?.selection2Id),
    externalPlayerId: null,
    externalGameId: str(datum.gameId),
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
 *
 * `options.atLine` asks each book, additionally, what it pays at one specific line -- what clicking
 * PropProfessor's own line dropdown does. It is an option rather than a property of the plan
 * because a plan is shared: the closing reader batches every pick on a (league, market) into one
 * request, and those picks were taken at different numbers, so there is no single line a plan could
 * name. The on-demand modal reads one pick at a time and passes that pick's line. Nothing about the
 * closing average changes either way -- see `priceAtLine` on `BookLine`.
 */
export function normalizeScreenMarket(
  raw: unknown,
  plan: ScreenReadPlan,
  options: { atLine?: number | null } = {}
): ParseResult {
  try {
    const body = raw as { game_data?: unknown };
    const data = body?.game_data;
    if (!Array.isArray(data)) {
      return { ok: false, reason: "response had no game_data array", headers: [], rows: [] };
    }

    // A moneyline has no line to ask about: its "line" is its price, so an alt-line lookup there
    // would be comparing a price against itself.
    const atLine =
      plan.marketType === "MONEYLINE" || typeof options.atLine !== "number" ? null : options.atLine;

    const rows: ParsedRow[] = [];
    // Markets the response says it is about, where it disagrees with the one that was asked for.
    // Collected rather than counted so the reason can name what came back instead.
    const wrongMarkets = new Set<string>();
    for (const datum of data as RawGameDatum[]) {
      if (!datum || typeof datum !== "object") continue;
      // The answer has to be about the question. Every captured response echoes the requested
      // market in this field, so a disagreement is not a spelling difference -- it is the screen
      // answering about something else, and a row built from it would be indistinguishable from a
      // good one downstream: `buildRow` stamps each row with the market name the *pick* used, so
      // `findMatchingRow`'s stat check compares that name against itself and always agrees. This is
      // the only place the two can still be compared.
      //
      // Compared on the base market, with any period qualifier dropped from both sides. All four
      // captured fixtures are full-game markets, so whether a period-qualified request comes back
      // echoing "Total Points - 1st Half" or just "Total Points" is unverified -- and guessing
      // wrong would reject every period read. The suffix is ours anyway (`withPeriod` appends it);
      // what this is guarding against is the screen answering about a different *stat*.
      //
      // A datum that names no market is left alone rather than rejected: absent is not a
      // contradiction.
      const answered = str(datum.market);
      if (answered !== null && baseMarket(answered) !== baseMarket(plan.body.market)) {
        wrongMarkets.add(answered);
        continue;
      }
      for (const side of [1, 2] as const) {
        const row = buildRow(datum, plan, side, rows.length, atLine);
        if (row) rows.push(row);
      }
    }

    if (rows.length === 0 && wrongMarkets.size > 0) {
      return {
        ok: false,
        reason:
          `asked for "${plan.body.market}" and the screen answered about ` +
          `${[...wrongMarkets].map((m) => `"${m}"`).join(", ")}`,
        headers: [],
        rows: [],
      };
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
