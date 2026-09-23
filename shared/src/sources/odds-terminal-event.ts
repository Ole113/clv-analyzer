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
export function oddsTerminalBooks(bookOrder: string[] = []): string[] {
  const rank = new Map(bookOrder.map((key, index) => [key, index]));
  return [...ODDS_TERMINAL_BOOKS]
    .sort((a, b) => {
      const ra = rank.get(a.key) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.key) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return ODDS_TERMINAL_BOOKS.indexOf(a) - ODDS_TERMINAL_BOOKS.indexOf(b);
    })
    .slice(0, ODDS_TERMINAL_MAX_BOOKS)
    // Ids, not names: this feeds the `sportsbook=` query parameter.
    .map((b) => b.id);
}

/**
 * Captured market name -> Odds Terminal `market_id`, per sport family.
 *
 * ## READ THIS BEFORE RELYING ON THIS TABLE
 *
 * **None of these are reachable through `/api/snapshot`.** Verified live on 2026-09-23 across all
 * sixteen sports the catalog knows: that endpoint returns *main markets only* -- for football,
 * exactly `moneyline`, `point_spread` and `total_points`, and the equivalent three elsewhere. A
 * `&market=` parameter is accepted and silently ignored, `&page=2` is empty, and `/api/players`
 * answers `400 Invalid player selection` to every shape tried. A pickem book (PrizePicks) returns
 * zero rows, which is the same story from the other direction.
 *
 * So the ids below are **not misspelled** -- they are unreachable. Odds Terminal's own web UI does
 * have a Player Props tab, so the data exists in the product; finding the endpoint that serves it
 * would mean reverse-engineering their JS bundle, which was deliberately not done.
 *
 * The table is kept rather than deleted because the moment a props endpoint is identified this is
 * most of the work already written. Until then, treat a player prop on this source as unanswerable
 * and prefer The Odds API tab, which does carry them.
 *
 * Its own table rather than a column on `ODDS_API_MARKETS`, for the same reason that one is its
 * own table: the vocabularies drift independently, and folding them together would make "this
 * source does not carry this market" indistinguishable from "we have not written the alias yet" --
 * which is precisely the distinction `resolveOddsTerminalMarket` exists to preserve.
 *
 * Keyed by `normalizeMarketName` output, with a `marketFilterKey` retry at lookup time so the bare
 * and "player"-prefixed spellings both land without being listed twice.
 */
const ODDS_TERMINAL_MARKETS: Record<string, Record<string, string>> = {
  football: {
    "passing yards": "player_passing_yards",
    "passing touchdowns": "player_passing_touchdowns",
    "passing attempts": "player_passing_attempts",
    "passing completions": "player_passing_completions",
    "interceptions thrown": "player_passing_interceptions",
    "rushing yards": "player_rushing_yards",
    "rushing attempts": "player_rushing_attempts",
    "receiving yards": "player_receiving_yards",
    receptions: "player_receptions",
    "rushing plus receiving yards": "player_rushing_receiving_yards",
    "passing plus rushing yards": "player_passing_rushing_yards",
    "kicking points": "player_kicking_points",
    tackles: "player_tackles_assists",
    "tackles plus assists": "player_tackles_assists",
  },
  basketball: {
    points: "player_points",
    rebounds: "player_rebounds",
    assists: "player_assists",
    "three pointers made": "player_three_pointers_made",
    steals: "player_steals",
    blocks: "player_blocks",
    turnovers: "player_turnovers",
    "points plus rebounds": "player_points_rebounds",
    "points plus assists": "player_points_assists",
    "rebounds plus assists": "player_rebounds_assists",
    "points plus rebounds plus assists": "player_points_rebounds_assists",
    "steals plus blocks": "player_steals_blocks",
  },
  baseball: {
    hits: "player_hits",
    "total bases": "player_total_bases",
    "runs batted in": "player_rbis",
    "runs scored": "player_runs",
    "home runs": "player_home_runs",
    "stolen bases": "player_stolen_bases",
    // The two "strikeouts" are different markets on the same word -- the reason these tables are
    // keyed by sport family and spelled out rather than guessed at.
    strikeouts: "player_pitcher_strikeouts",
    "pitcher strikeouts": "player_pitcher_strikeouts",
    "batter strikeouts": "player_batter_strikeouts",
    "hits allowed": "player_hits_allowed",
    "earned runs": "player_earned_runs",
    outs: "player_pitching_outs",
  },
  hockey: {
    points: "player_points",
    goals: "player_goals",
    assists: "player_assists",
    "shots on goal": "player_shots_on_goal",
    saves: "player_saves",
    "blocked shots": "player_blocked_shots",
  },
};

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
  | { marketId: string }
  | { kind: "noEquivalent"; reason: string }
  | { kind: "unmapped"; reason: string };

/**
 * Which Odds Terminal market a captured market name is, if any.
 *
 * Three outcomes rather than two, the same discipline `resolveOddsApiMarket` uses: a market this
 * source genuinely does not carry is a blameless dead end the user should be told about plainly,
 * while a market it probably does carry under a name we have not written down yet is a gap in this
 * table that someone should close. Collapsing them into one "not found" is what makes such gaps
 * invisible.
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

  // Resolved per family, because the id for "the spread" is not the same word in every sport.
  const gameMarket = gameMarketId(family, marketType, stat);
  if (typeof gameMarket === "string") return { marketId: gameMarket };
  if (gameMarket !== null) {
    return {
      kind: "noEquivalent",
      reason: `Odds Terminal does not carry ${gameMarket.unsupported} for ${sport}.`,
    };
  }

  const table = ODDS_TERMINAL_MARKETS[family];
  if (!table) {
    return { kind: "noEquivalent", reason: `Odds Terminal carries no player props for ${sport}.` };
  }
  const hit = table[stat] ?? table[marketFilterKey(statMarket)];
  if (!hit) {
    return {
      kind: "unmapped",
      reason: `No Odds Terminal market is mapped for "${statMarket ?? "(none)"}" in ${sport}`,
    };
  }
  return { marketId: hit };
}

// --- read planning ----------------------------------------------------------------------------

export interface OddsTerminalReadPlan {
  /** The `sport` query value. */
  sport: string;
  /** The league id a returned fixture must carry to be this pick's game. */
  league: string;
  /** The `market_id` the flat odds array is filtered to. */
  marketId: string;
  /** The `sportsbook` query values, at most `ODDS_TERMINAL_MAX_BOOKS` of them. */
  sportsbooks: string[];
  marketType: MarketType;
  /** The market name as the *pick* spells it, carried through so the shared matcher still works. */
  requestedStatMarket: string;
}

export interface UnplannableOddsTerminalRead {
  kind: "noEquivalent" | "unmapped";
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

// --- response parsing -------------------------------------------------------------------------

interface RawOdd {
  sportsbook?: unknown;
  market_id?: unknown;
  market?: unknown;
  name?: unknown;
  price?: unknown;
  points?: unknown;
  selection?: unknown;
  normalized_selection?: unknown;
  is_main?: unknown;
  fixture_id?: unknown;
  is_live?: unknown;
}

export interface OddsTerminalSnapshot {
  fixtures?: unknown;
  odds?: unknown;
}

/** The two sides of the market, as an odd's `selection`/`name` spells them. */
function sidesFor(marketType: MarketType, home: string | null, away: string | null): [string, string] {
  return marketType === "MONEYLINE" || marketType === "SPREAD"
    ? [home ?? "Home", away ?? "Away"]
    : ["Over", "Under"];
}

/**
 * Which side of the market one odd prices, or null when it prices neither.
 *
 * On a player prop or a total the side is literally "Over"/"Under" and the *player* is carried
 * separately. On a spread or moneyline the selection is a team name, so the side collapses into
 * which team the entry is about -- matched with the same `sameTeam` leniency fixtures are, since
 * these are the same inconsistently-abbreviated club names.
 */
function sideOf(
  odd: RawOdd,
  marketType: MarketType,
  sideOne: string,
  sideTwo: string
): 1 | 2 | null {
  const raw = str(odd.selection) ?? str(odd.normalized_selection) ?? str(odd.name);
  if (!raw) return null;
  if (marketType === "MONEYLINE" || marketType === "SPREAD") {
    const selection = normalizeName(raw);
    if (sameTeam(selection, normalizeName(sideOne))) return 1;
    if (sameTeam(selection, normalizeName(sideTwo))) return 2;
    return null;
  }
  const lowered = raw.toLowerCase();
  if (lowered.includes("over")) return 1;
  if (lowered.includes("under")) return 2;
  return null;
}

/**
 * Which player (or team, on a team total) one odd is about.
 *
 * Empty string for a market with exactly one selection per side -- a game total, a moneyline --
 * which is what groups every book's opinion of that one market into a single bucket.
 */
function selectionKeyFor(odd: RawOdd, marketType: MarketType): string {
  if (marketType === "MONEYLINE" || marketType === "SPREAD") return "";
  const raw = str(odd.normalized_selection) ?? str(odd.selection) ?? str(odd.name) ?? "";
  // "Josh Allen Over 249.5" -- strip the side and number so the bucket key is the player alone.
  // A bare "Over"/"Under" (a game total) reduces to "", which is exactly the single-bucket case.
  const stripped = raw
    .replace(/\b(over|under)\b/gi, " ")
    .replace(/[-+]?\d+(\.\d+)?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped;
}

/**
 * Turns one snapshot into rows the existing matcher and verdict builder understand.
 *
 * Emits one row per (selection, side), exactly as `normalizeOddsApiEvent` does: a player prop
 * becomes an OVER row and an UNDER row per player, because `findMatchingRow` identifies a prop by
 * player + stat + side. A game market becomes one row per team.
 *
 * Never throws -- a malformed payload returns `{ ok: false, reason }` the way every parser in this
 * project does, because the caller is a modal a person is watching.
 */
export function normalizeOddsTerminalSnapshot(
  raw: unknown,
  plan: OddsTerminalReadPlan,
  fixture: OddsTerminalFixture,
  options: { atLine?: number | null } = {}
): ParseResult {
  try {
    const body = raw as OddsTerminalSnapshot;
    if (!body || typeof body !== "object") {
      return { ok: false, reason: "the snapshot was not an object", headers: [], rows: [] };
    }
    const odds = body.odds;
    if (!Array.isArray(odds)) {
      return { ok: false, reason: "the snapshot had no odds array", headers: [], rows: [] };
    }

    const fixtureId = str(fixture.id);
    const { home, away } = fixtureTeams(fixture);
    const [sideOneName, sideTwoName] = sidesFor(plan.marketType, home, away);
    // A moneyline has no line to ask about: its "line" is its price, so an alt-line lookup there
    // would be comparing a price against itself.
    const atLine =
      plan.marketType === "MONEYLINE" || typeof options.atLine !== "number" ? null : options.atLine;

    /**
     * Quotes grouped by selection, then by which side they price.
     *
     * The flat `odds[]` array is the whole reason this shape is built here: every book's opinion
     * of one player arrives scattered across the array and has to be gathered into one place
     * before `pickMainLines` can be asked which line each book is really on.
     */
    const bySelection = new Map<string, { one: BookQuote[]; two: BookQuote[] }>();
    // One book's two sides at one line, paired before either is usable: a de-vig needs both, and
    // the main-line choice is made from both.
    //
    // The book and selection are carried *on* the pair rather than parsed back out of the key:
    // "Hard Rock" and "Josh Allen" both contain spaces, so any attempt to split the key apart
    // again would silently mis-attribute every multi-word book and every player.
    type Pair = { sportsbook: string; selection: string; one: RawOdd | null; two: RawOdd | null };
    const pairs = new Map<string, Pair>();
    // Markets present in the array that we did not ask for, kept only to explain an empty result.
    const otherMarkets = new Set<string>();

    for (const entry of odds as RawOdd[]) {
      if (!entry || typeof entry !== "object") continue;
      if (fixtureId !== null && str(entry.fixture_id) !== fixtureId) continue;

      const marketId = str(entry.market_id);
      if (marketId !== plan.marketId) {
        if (marketId) otherMarkets.add(marketId);
        continue;
      }
      const sportsbook = str(entry.sportsbook);
      if (!sportsbook) continue;

      const side = sideOf(entry, plan.marketType, sideOneName, sideTwoName);
      if (side === null) continue;

      const selection = selectionKeyFor(entry, plan.marketType);
      const points = num(entry.points);
      // Keyed on the line as well as the book and selection: a book quoting 14.5 and 15.5 for one
      // player must not have its Over 14.5 paired with its Under 15.5.
      const pairKey = `${sportsbook}::${selection}::${points ?? "null"}`;
      const pair = pairs.get(pairKey) ?? { sportsbook, selection, one: null, two: null };
      if (side === 1) pair.one = entry;
      else pair.two = entry;
      pairs.set(pairKey, pair);
    }

    for (const { sportsbook, selection, ...pair } of pairs.values()) {
      const priceOne = num(pair.one?.price);
      const priceTwo = num(pair.two?.price);
      if (priceOne === null && priceTwo === null) continue;

      const pointsOne = num(pair.one?.points);
      const pointsTwo = num(pair.two?.points);
      const bucket = bySelection.get(selection) ?? { one: [], two: [] };
      const bookKey = normalizeOddsTerminalBookKey(sportsbook);

      // Each side keeps its *own* points. On a prop the two agree, but a spread quotes +7 to one
      // team and -7 to the other in the same pairing, so neither side may borrow the other's.
      bucket.one.push({
        bookKey,
        label: sportsbook,
        // A moneyline has no number to move, so the price is the tracked line -- the convention
        // every other parser here uses, which keeps `computeClv`'s arithmetic intact.
        line: plan.marketType === "MONEYLINE" ? priceOne : (pointsOne ?? pointsTwo),
        price: priceOne,
        otherSidePrice: priceTwo,
        // `/api/snapshot` publishes no depth. Genuinely unknown rather than zero -- the exchanges
        // do have real depth, it is just not on this endpoint.
        liquidity: null,
      });
      bucket.two.push({
        bookKey,
        label: sportsbook,
        line: plan.marketType === "MONEYLINE" ? priceTwo : (pointsTwo ?? pointsOne),
        price: priceTwo,
        otherSidePrice: priceOne,
        liquidity: null,
      });
      bySelection.set(selection, bucket);
    }

    const rows: ParsedRow[] = [];
    for (const [selection, bucket] of bySelection) {
      for (const side of [1, 2] as const) {
        const row = buildRow({
          plan,
          selection,
          quotes: side === 1 ? bucket.one : bucket.two,
          side,
          sideName: side === 1 ? sideOneName : sideTwoName,
          home,
          away,
          rowIndex: rows.length,
          atLine,
          fixture,
        });
        if (row) rows.push(row);
      }
    }

    if (rows.length === 0 && otherMarkets.size > 0) {
      return {
        ok: false,
        reason:
          `asked for "${plan.marketId}" and the snapshot carried only ` +
          `${[...otherMarkets].slice(0, 4).map((m) => `"${m}"`).join(", ")}`,
        headers: [],
        rows: [],
      };
    }

    return {
      ok: true,
      headers: [plan.sport, plan.marketId],
      rows,
      reason: rows.length === 0 ? "the market returned no priced selections" : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "could not read the snapshot",
      headers: [],
      rows: [],
    };
  }
}

function buildRow(input: {
  plan: OddsTerminalReadPlan;
  selection: string;
  quotes: BookQuote[];
  side: 1 | 2;
  sideName: string;
  home: string | null;
  away: string | null;
  rowIndex: number;
  atLine: number | null;
  fixture: OddsTerminalFixture;
}): ParsedRow | null {
  const { plan, selection, side, sideName, home, away, atLine, fixture } = input;
  const books = pickMainLines(input.quotes, atLine);
  if (books.size === 0) return null;

  const isGameMarket = plan.marketType === "MONEYLINE" || plan.marketType === "SPREAD";
  const pickSide: PickSide | null = isGameMarket ? null : side === 1 ? "OVER" : "UNDER";
  const isTeamTotal = plan.marketId === "team_total";

  const bookLines = [...books.entries()]
    // A moneyline's tracked line IS its price, so a book not pricing this team has nothing to
    // contribute; on every other market the line stands on its own.
    .filter(([, b]) => plan.marketType !== "MONEYLINE" || b.price !== null)
    // A prop or spread whose best price is nowhere near even money is not a line anyone is really
    // offering -- typically one resting exchange order. Never applied to moneylines, where -1000
    // is an ordinary price for a heavy favourite.
    .filter(([, b]) => plan.marketType === "MONEYLINE" || b.nearMarket)
    .map(([bookKey, b]) => {
      const alts = b.selectionsSeen.filter((l) => l !== b.line);
      return {
        bookKey,
        label: b.label,
        line: b.line,
        price: b.price,
        liquidity: null,
        // This book's own no-vig probability for the side taken, where it priced both sides. The
        // consensus of these is formed downstream, over exactly the books that survive the
        // sportsbook allowlist and the outlier test.
        fairProbability: devigTwoWay(b.price, b.otherSidePrice),
        priceAtLine: b.priceAtLine,
        // JSON, so there is no logo to scrape -- looked up from the book's key exactly as on every
        // other path, which is what makes all tabs render the same icons.
        logoUrl: bookLogoUrl(bookKey, b.label),
        rawText:
          `${b.line ?? "-"} @ ${b.price ?? "no price this side"}` +
          (alts.length > 0 ? ` (also quoted ${alts.join(", ")})` : "") +
          (atLine !== null && b.line !== atLine
            ? `; at ${atLine}: ${b.priceAtLine ?? "not quoted"}`
            : ""),
      };
    });

  if (bookLines.length === 0) return null;

  const usable = bookLines.map((b) => b.line).filter((l): l is number => l !== null);
  const takenLine =
    usable.length > 0
      ? Math.round((usable.reduce((sum, l) => sum + l, 0) / usable.length) * 100) / 100
      : null;

  const startDate = str(fixture.start_date);

  return {
    rowIndex: input.rowIndex,
    marketType: plan.marketType,
    player: isGameMarket || isTeamTotal ? null : (selection || null),
    selectionName: isGameMarket ? sideName : selection || sideName,
    subjectTeam: isGameMarket ? sideName : isTeamTotal ? selection || null : null,
    isLive: fixture.is_live === true,
    team: home,
    opponent: away,
    matchup: home && away ? `${away} vs ${home}` : null,
    sport: plan.league.toUpperCase(),
    // Deliberately the market name as the *pick* spells it, not the source's id. The alias table
    // asserts the two name one market, so translating here is what lets the shared matcher keep
    // working unchanged.
    statMarket: plan.requestedStatMarket,
    side: pickSide,
    takenLine,
    // No row-level de-vigged probability, for the same reason every other source leaves this null:
    // the honest consensus can only be taken after the allowlist and the outlier test have run,
    // which happens in `buildClosingVerdict`. One closing fair probability, not two that disagree.
    fairProbability: null,
    boardEvPercent: null,
    gameStartTimeText: startDate,
    gameStartTimeIso: startDate,
    externalPropId: null,
    externalPlayerId: null,
    externalGameId: str(fixture.id),
    bookLines,
    rawText: JSON.stringify({
      source: "odds-terminal-snapshot",
      sport: plan.sport,
      league: plan.league,
      market: plan.marketId,
      fixtureId: str(fixture.id),
      selection,
      bookCount: bookLines.length,
    }),
  };
}
