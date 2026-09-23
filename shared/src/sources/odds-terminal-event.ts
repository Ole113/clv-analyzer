/**
 * Odds Terminal's `/api/snapshot`, turned into the same `ParsedRow`s every other source produces.
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is a **pure parser and planner**. It names no host, opens no connection and has no idea how
 * the bytes it is handed were obtained -- which is the property that lets it live in
 * `shared/src/sources/` alongside the others without tripping the automation guard's allowlist
 * (`oddsjam-automation-guard.test.ts` scans this whole directory for hostnames).
 *
 * That is not an accident of layering, it is the design. The fetch itself happens in
 * `extension/src/content/oddsterminal-site/relay.ts`, inside a tab the user's own click opened,
 * against a **same-origin relative path**. No server-side or background code ever contacts Odds
 * Terminal -- that exact shape (a captured session driving backend-initiated reads) is what got
 * the PropProfessor account banned, and this source is treated as being in the same risk class.
 *
 * ## The response shape this parses
 *
 * `GET /api/snapshot?sport=<sport>&sportsbook=<book>&...` (between one and five `sportsbook`
 * params, or the API 400s) answers with:
 *
 * ```json
 * {
 *   "coverage": { "DraftKings": { "returned": 12, ... } },
 *   "fixtures": [ { "id", "sport": {id,name}, "league": {id,name}, "start_date",
 *                   "home_competitors": [{name,...}], "away_competitors": [...],
 *                   "home_team_display", "away_team_display", ... } ],
 *   "odds": [ { "sportsbook", "market", "market_id", "name", "price", "points",
 *               "selection", "normalized_selection", "is_main", "fixture_id", ... } ]
 * }
 * ```
 *
 * The critical structural difference from The Odds API: **odds are a flat array keyed by
 * `fixture_id`, not nested under their fixture.** So a read resolves a fixture first and then
 * filters the flat array to it, rather than being handed one event's odds.
 *
 * ## What it shares with the other sources, on purpose
 *
 * Line selection goes through the shared `pickMainLines` (`main-line.ts`) untouched. Two tabs
 * quoting different "main lines" for one market because each source reconstructed the idea
 * differently would read as a disagreement between sportsbooks when it is really a disagreement
 * between two of our own parsers -- the whole reason that module was extracted.
 */

import type { MarketType, ParseResult, ParsedRow, PickSide } from "../types";
import { bookLogoUrl, normalizeBookKey } from "../books";
import { marketFilterKey, normalizeMarketName, propProfessorLeague } from "../markets";
import { normalizeName } from "../matching";
import { devigTwoWay } from "../devig";
import { pickMainLines, type BookQuote } from "./main-line";

// --- vocabulary -------------------------------------------------------------------------------

/**
 * Our league code -> Odds Terminal's `sport` query value and its own league id.
 *
 * The `sport` value is what the endpoint is keyed by; the `league` is what a returned fixture
 * carries in `league.id`, and is how a multi-league sport ("football" covers NFL, NCAAF and CFL at
 * once) is narrowed back down to the one the pick is about.
 *
 * Tennis, soccer, golf and MMA are absent for the same reason they are absent from
 * `ODDS_API_SPORTS`: our league vocabulary collapses every tournament into one code, and a source
 * that keys them per competition cannot be asked about "Tennis" without guessing which event. An
 * honest "not covered" beats an answer about the wrong match.
 *
 * Matching on these ids is deliberately lenient (see `sameLeague`) and *fails closed*: a fixture
 * whose league cannot be confirmed as the pick's is not matched at all, rather than being assumed.
 */
export const ODDS_TERMINAL_SPORTS: Record<string, { sport: string; league: string }> = {
  NFL: { sport: "football", league: "nfl" },
  NCAAF: { sport: "football", league: "ncaaf" },
  CFL: { sport: "football", league: "cfl" },
  NBA: { sport: "basketball", league: "nba" },
  NCAAB: { sport: "basketball", league: "ncaab" },
  WNBA: { sport: "basketball", league: "wnba" },
  NHL: { sport: "hockey", league: "nhl" },
  MLB: { sport: "baseball", league: "mlb" },
};

/**
 * The books this source may be asked for, in preference order.
 *
 * ## Two spellings, because the API uses two
 *
 * Confirmed against a live `/api/catalog?sport=football` (2026-09-23): each book has a lowercase
 * `id` ("draftkings") and a display `name` ("DraftKings"), and **they are not interchangeable**:
 *
 *  - the `sportsbook=` query parameter takes the **id**. `sportsbook=DraftKings` is not what the
 *    endpoint expects;
 *  - `odds[].sportsbook` in the response comes back as the **name**.
 *
 * So the query is built from `id` and the parse is keyed on `name`. Keeping only one of the two --
 * which is what this table did first -- meant either an unanswerable query or unattributable rows.
 *
 * `key` is the key this project already uses for the same book, so `SPORTSBOOK_HINTS`,
 * `BOOK_DOMAINS`, the book order and the outlier test all apply downstream with no special-casing.
 *
 * ## Why some obvious books are absent
 *
 * ESPN BET, Prophet X and Underdog were in this table and are **not offered by this source**: the
 * catalog lists 216 books and none of them is any of those three (ESPN BET appears in the
 * catalog's own `missing` list, i.e. known but not carried). Asking for a book the endpoint does
 * not know wastes one of only five slots, so they are gone rather than left in hopefully.
 */
export interface OddsTerminalBook {
  /** What `sportsbook=` wants. */
  id: string;
  /** What `odds[].sportsbook` returns. */
  name: string;
  /** This project's own book key. */
  key: string;
}

export const ODDS_TERMINAL_BOOKS: OddsTerminalBook[] = [
  { id: "pinnacle", name: "Pinnacle", key: "pinnacle" },
  { id: "fanduel", name: "FanDuel", key: "fanduel" },
  { id: "draftkings", name: "DraftKings", key: "draftkings" },
  { id: "betmgm", name: "BetMGM", key: "betmgm" },
  { id: "caesars", name: "Caesars", key: "caesars" },
  { id: "fanatics", name: "Fanatics", key: "fanatics" },
  { id: "betrivers", name: "BetRivers", key: "betrivers" },
  { id: "novig", name: "Novig", key: "novig" },
  { id: "kalshi", name: "Kalshi", key: "kalshi" },
  { id: "polymarket", name: "Polymarket", key: "polymarket" },
  { id: "betonline", name: "BetOnline", key: "betonline" },
  // The id is `hard_rock`, with the underscore -- not `hardrock`, which is what our own
  // `normalizeBookKey` would produce and what this table used to assume.
  { id: "hard_rock", name: "Hard Rock", key: "hardrock" },
  { id: "fliff", name: "Fliff", key: "fliff" },
  { id: "bovada", name: "Bovada", key: "bovada" },
  // DFS/pickem. Never averaged (`isSportsbookForClose` denies them), but worth showing: a DFS line
  // beside the sportsbook consensus is the comparison the Odds modal exists to make.
  { id: "prizepicks", name: "PrizePicks", key: "prizepicks" },
];

/** Display name -> our book key, for reading a response. */
const BOOK_KEY_BY_NAME = new Map(ODDS_TERMINAL_BOOKS.map((b) => [b.name, b.key]));

/** The endpoint's own ceiling: more than five `sportsbook` params is a 400, not a truncation. */
export const ODDS_TERMINAL_MAX_BOOKS = 5;

/** This project's book key for one of Odds Terminal's display names. */
export function normalizeOddsTerminalBookKey(sportsbook: string): string {
  return BOOK_KEY_BY_NAME.get(sportsbook) ?? normalizeBookKey(sportsbook) ?? "unknown";
}

/**
 * Which five books to ask for, ranked by the user's own book order.
 *
 * Identical in spirit to `oddsApiBookmakers`: the install's ranking decides which of the supported
 * books make the cut, and anything the user has not ranked falls in behind them in the table's own
 * order. Five slots is not many, which is exactly why the ranking has to be honoured rather than a
 * fixed five being hardcoded.
 */
function rankedBooks(bookOrder: string[]): OddsTerminalBook[] {
  const rank = new Map(bookOrder.map((key, index) => [key, index]));
  return [...ODDS_TERMINAL_BOOKS]
    .sort((a, b) => {
      const ra = rank.get(a.key) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.key) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return ODDS_TERMINAL_BOOKS.indexOf(a) - ODDS_TERMINAL_BOOKS.indexOf(b);
    })
    .slice(0, ODDS_TERMINAL_MAX_BOOKS);
}

/**
 * The books to ask for, as `/api/snapshot` wants them: lowercase ids.
 *
 * Confirmed live -- `sportsbook=draftkings` is accepted there.
 */
export function oddsTerminalBooks(bookOrder: string[] = []): string[] {
  return rankedBooks(bookOrder).map((b) => b.id);
}

/**
 * The books to ask for, as `/api/stream` wants them: display names.
 *
 * The two endpoints disagree, which is the kind of thing no amount of reasoning would have
 * predicted. The evidence is a captured stream URL that reads `...&sportsbook=Kalshi` -- the
 * display name, where the snapshot endpoint takes `kalshi`. Only the name form is actually
 * attested for this endpoint, so that is what is sent; sending the id here is an untested guess,
 * and a rejected `sportsbook` returns nothing for the whole read rather than just that book.
 */
export function oddsTerminalStreamBooks(bookOrder: string[] = []): string[] {
  return rankedBooks(bookOrder).map((b) => b.name);
}

/**
 * There is no player-prop market table any more, and that is deliberate.
 *
 * There used to be one, with roughly fifty hand-written ids. Every one of them was wrong. The live
 * feed slugs its own display names, punctuation included -- "Player Hits + Runs + RBIs" is
 * `player_hits_+_runs_+_rbis` -- which is not guessable, and a wrong id renders as an empty tab
 * with nothing to explain it.
 *
 * `/api/stream?...&mode=all` returns every market for a fixture, so nothing needs to be named in
 * advance: the filtering happens on the way out, by running the feed's own market name and the
 * pick's through `marketFilterKey`. See `odds-terminal-stream.ts`. That is what makes this source
 * work for *any* prop the site carries, rather than for the subset somebody remembered to type in.
 */

/**
 * The game markets each sport family actually offers, straight from the live catalog.
 *
 * ## Why this is a table and not three constants
 *
 * It used to hardcode `point_spread` and `total_points` for every sport, which is right for
 * football and basketball and **wrong for everything else**. Confirmed against
 * `/api/catalog?sport=<sport>` (2026-09-23): baseball quotes `run_line`/`total_runs`, hockey
 * `puck_line`/`total_goals`. An MLB or NHL game market would have been planned against an id this
 * source has never heard of, and -- because the parser filters `odds[]` on `market_id` -- the tab
 * would have come back empty for every one of them, with nothing to say why.
 *
 * Worth stating plainly, since it is the reason this matters more than it looks: game markets are
 * the *only* thing `/api/snapshot` carries (see `ODDS_TERMINAL_MARKETS` below), so a bug in this
 * table is a bug in everything this source can actually answer.
 *
 * The other families the catalog reports -- soccer `asian_handicap`/`total_goals`, tennis
 * `game_spread`/`total_games`, and so on -- are deliberately absent, because `ODDS_TERMINAL_SPORTS`
 * does not map a league onto them; there is nothing that could reach this table asking for one.
 */
const GAME_MARKETS: Record<string, { spread: string; total: string }> = {
  football: { spread: "point_spread", total: "total_points" },
  basketball: { spread: "point_spread", total: "total_points" },
  baseball: { spread: "run_line", total: "total_runs" },
  hockey: { spread: "puck_line", total: "total_goals" },
};

/** The game-market id for a market type in one sport family, or null when it is not a game
 *  market. `unsupported` means it is one, but not one this family offers. */
function gameMarketId(
  family: string,
  marketType: MarketType,
  stat: string
): string | { unsupported: string } | null {
  if (marketType === "MONEYLINE") return "moneyline";
  const markets = GAME_MARKETS[family];
  if (marketType === "SPREAD") {
    return markets ? markets.spread : { unsupported: "spreads" };
  }
  if (marketType === "GAME_TOTAL") {
    // Team totals are not a main market on this endpoint, and main markets are all it serves --
    // the catalog lists exactly three per sport and `team_total` is not among them. Guessing an id
    // would produce an empty tab indistinguishable from "the game has no market yet", so this says
    // so instead. Same fail-closed discipline as the league and fixture matching.
    if (/team/.test(stat)) return { unsupported: "team totals" };
    return markets ? markets.total : { unsupported: "totals" };
  }
  return null;
}

export type ResolvedOddsTerminalMarket =
  | { marketId: string | null }
  | { kind: "noEquivalent"; reason: string };

/**
 * Which Odds Terminal market a captured market name is.
 *
 * Only *game* markets resolve to an id, because only they are named in a query. A player prop
 * returns `{ marketId: null }` -- not a failure, and not an id we pretend to know: props are
 * matched by name against what the stream actually returns.
 */
export function resolveOddsTerminalMarket(
  sport: string,
  marketType: MarketType,
  statMarket: string | null
): ResolvedOddsTerminalMarket {
  const stat = normalizeMarketName(statMarket);
  const family = ODDS_TERMINAL_SPORTS[sport]?.sport;
  if (!family) {
    return {
      kind: "noEquivalent",
      reason: `Odds Terminal is not covered for ${sport} in this extension yet.`,
    };
  }

  const gameMarket = gameMarketId(family, marketType, stat);
  if (typeof gameMarket === "string") return { marketId: gameMarket };
  if (gameMarket !== null) {
    return {
      kind: "noEquivalent",
      reason: `Odds Terminal does not carry ${gameMarket.unsupported} for ${sport}.`,
    };
  }
  // A player prop. No id, by design.
  return { marketId: null };
}

// --- read planning ----------------------------------------------------------------------------

export interface OddsTerminalReadPlan {
  /** The `sport` query value. */
  sport: string;
  /** The league id a returned fixture must carry to be this pick's game. */
  league: string;
  /**
   * The `market_id` for a game market, or null for a player prop.
   *
   * Null is the normal case and not a gap: props are filtered by market *name* against what the
   * stream returns, so there is no id to carry. See `odds-terminal-stream.ts`.
   */
  marketId: string | null;
  /** The snapshot's `sportsbook` values (ids), at most `ODDS_TERMINAL_MAX_BOOKS` of them. */
  sportsbooks: string[];
  /** The user's own book ranking, kept so the stream can re-derive its own (name) spelling. */
  bookOrder: string[];
  marketType: MarketType;
  /** The market name as the *pick* spells it, carried through so the shared matcher still works. */
  requestedStatMarket: string;
}

export interface UnplannableOddsTerminalRead {
  kind: "noEquivalent";
  reason: string;
}

/**
 * What to ask Odds Terminal for, from the pick's identity alone.
 *
 * Takes no URL, by design and by test: a stored `pageUrl` must never be able to steer where a read
 * goes. The capture site is provenance and nothing more.
 */
export function planOddsTerminalRead(
  pick: { sport: string | null; statMarket: string | null; marketType: MarketType },
  options: { bookOrder?: string[] } = {}
): OddsTerminalReadPlan | UnplannableOddsTerminalRead {
  const league = propProfessorLeague(pick.sport);
  if (!league) {
    return { kind: "noEquivalent", reason: `No league could be resolved from "${pick.sport}".` };
  }
  const sport = ODDS_TERMINAL_SPORTS[league];
  if (!sport) {
    return { kind: "noEquivalent", reason: `Odds Terminal does not cover ${league} here.` };
  }
  const market = resolveOddsTerminalMarket(league, pick.marketType, pick.statMarket);
  if ("kind" in market) return market;

  return {
    sport: sport.sport,
    league: sport.league,
    marketId: market.marketId,
    sportsbooks: oddsTerminalBooks(options.bookOrder ?? []),
    bookOrder: options.bookOrder ?? [],
    marketType: pick.marketType,
    requestedStatMarket: pick.statMarket ?? "",
  };
}

/**
 * The snapshot query, as a **path and query string only** -- never an absolute URL.
 *
 * This is the single most important line in the module. The relay fetches this against its own
 * origin from inside a tab the user opened; returning a relative path is what makes it impossible
 * for this module (or anything importing it) to name the host, and impossible for server or
 * background code to accidentally turn a plan into an outbound request.
 */
export function oddsTerminalSnapshotPath(plan: OddsTerminalReadPlan): string {
  const params = new URLSearchParams();
  params.set("sport", plan.sport);
  for (const book of plan.sportsbooks) params.append("sportsbook", book);
  return `/api/snapshot?${params.toString()}`;
}

// --- fixture resolution -----------------------------------------------------------------------

export interface OddsTerminalFixture {
  id?: unknown;
  league?: unknown;
  start_date?: unknown;
  status?: unknown;
  is_live?: unknown;
  home_competitors?: unknown;
  away_competitors?: unknown;
  home_team_display?: unknown;
  away_team_display?: unknown;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Splits "Boston College vs. Rutgers" / "Rutgers @ Boston College" into its normalized sides. */
function matchupSides(matchup: string | null): string[] {
  if (!matchup) return [];
  return matchup
    .split(/\s+(?:vs\.?|v\.?|@|at)\s+/i)
    .map((s) => normalizeName(s))
    .filter(Boolean);
}

/** True when a normalized board team name and a snapshot team name are plausibly the same club. */
function sameTeam(boardTeam: string, feedTeam: string): boolean {
  if (!boardTeam || !feedTeam) return false;
  if (boardTeam === feedTeam) return true;
  if (feedTeam.includes(boardTeam) || boardTeam.includes(feedTeam)) return true;
  // "LA Rams" vs "Los Angeles Rams": the nickname is the last word and is what actually identifies
  // a club, the city being exactly the part boards abbreviate inconsistently.
  const boardWords = boardTeam.split(" ");
  const feedWords = feedTeam.split(" ");
  const boardNick = boardWords[boardWords.length - 1];
  const feedNick = feedWords[feedWords.length - 1];
  return boardNick.length > 3 && boardNick === feedNick;
}

/**
 * Whether a fixture's league is the one the plan asked about.
 *
 * Lenient on spelling (`{id,name}`, either of which may be what this deployment populates, in
 * whatever case) but strict on absence: a fixture carrying no recognisable league at all is **not**
 * assumed to be the right one. One `sport=football` snapshot holds NFL, NCAAF and CFL games
 * together, so assuming would mean quietly answering an NFL question with a college game.
 */
function sameLeague(fixture: OddsTerminalFixture, league: string): boolean {
  const raw = fixture.league;
  const entry = raw && typeof raw === "object" ? (raw as { id?: unknown; name?: unknown }) : null;
  const candidates = [
    str(entry?.id),
    str(entry?.name),
    typeof raw === "string" ? raw : null,
  ].filter((s): s is string => s !== null);
  if (candidates.length === 0) return false;
  const want = normalizeName(league);
  return candidates.some((c) => normalizeName(c) === want);
}

/** A fixture's two team names, preferring the display strings and falling back to the competitor
 *  arrays -- both are populated in practice and neither is guaranteed. */
export function oddsTerminalFixtureTeams(
  fixture: OddsTerminalFixture
): { home: string | null; away: string | null } {
  return fixtureTeams(fixture);
}

function fixtureTeams(fixture: OddsTerminalFixture): { home: string | null; away: string | null } {
  const fromList = (v: unknown): string | null => {
    if (!Array.isArray(v) || v.length === 0) return null;
    const first = v[0] as { name?: unknown } | null;
    return str(first?.name);
  };
  return {
    home: str(fixture.home_team_display) ?? fromList(fixture.home_competitors),
    away: str(fixture.away_team_display) ?? fromList(fixture.away_competitors),
  };
}

/**
 * Which listed fixture a pick is about.
 *
 * Same integration risk, and therefore the same discipline, as `findOddsApiEvent`: the only handle
 * a pick carries is a matchup written in whatever prose its board used, both sides have to match,
 * and **ambiguity is a refusal rather than a coin toss**. Two fixtures matching one matchup means
 * the team names did not identify a game; returning the wrong one is far worse than returning
 * none, because the market would then parse perfectly and describe a different game.
 */
export function findOddsTerminalFixture(
  fixtures: OddsTerminalFixture[],
  plan: OddsTerminalReadPlan,
  target: { matchup: string | null; subjectTeam: string | null }
): OddsTerminalFixture | null {
  const sides = matchupSides(target.matchup);
  const subject = normalizeName(target.subjectTeam);

  const candidates = fixtures.filter((fixture) => {
    if (!sameLeague(fixture, plan.league)) return false;
    const { home: rawHome, away: rawAway } = fixtureTeams(fixture);
    const home = normalizeName(rawHome);
    const away = normalizeName(rawAway);
    if (!home || !away) return false;

    if (sides.length >= 2) {
      // Either orientation: boards disagree about whether the home team is written first.
      return (
        (sameTeam(sides[0], home) && sameTeam(sides[1], away)) ||
        (sameTeam(sides[0], away) && sameTeam(sides[1], home))
      );
    }
    // No usable matchup. A game market still carries its own team, which names one side of exactly
    // one fixture in a round -- enough on its own, and the only fallback available.
    if (subject) return sameTeam(subject, home) || sameTeam(subject, away);
    return false;
  });

  return candidates.length === 1 ? candidates[0] : null;
}

// --- the snapshot's only remaining job ---------------------------------------------------------

/**
 * The snapshot response, as far as this module still cares about it.
 *
 * It used to be parsed for odds. It is not any more: `/api/snapshot` serves main markets only
 * (verified live across all sixteen sports), so the odds come from `/api/stream` instead -- see
 * `odds-terminal-stream.ts`. What the snapshot is still needed for, and the reason it is still
 * fetched first, is that the stream requires a `fixture_id` and offers no way to discover one.
 *
 * So the flow is: snapshot to find the fixture, stream to price it.
 */
export interface OddsTerminalSnapshot {
  fixtures?: unknown;
  odds?: unknown;
}

