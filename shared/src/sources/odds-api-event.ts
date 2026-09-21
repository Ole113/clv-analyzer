/**
 * Current lines from The Odds API, the Odds modal's second source.
 *
 * ## Why a second source at all
 *
 * The PropProfessor read works by borrowing a live session token out of the user's own browser
 * (`pp-token.ts`, the extension's mint-and-relay fallback, the whole `TokenRejectedError` path).
 * That is a lot of machinery standing between a click and an answer, and every part of it can be
 * down at the moment someone actually wants a number: no browser open, no PropProfessor tab, a
 * session that expired ten minutes ago. The Odds API is a keyed, metered, entirely ordinary HTTP
 * API -- legitimate traffic, no borrowed credential, and it answers from the server alone.
 *
 * It does not replace PropProfessor, and this file is deliberately not wired into the scheduled
 * closing read. PropProfessor stays the default and the closing authority; this is the thing to
 * click when the default cannot answer, or when a second opinion on the same market is worth a
 * credit. See `odds-api-read.ts` for the cost story.
 *
 * ## Deliberately the same arithmetic
 *
 * Nothing here averages, filters or de-vigs. This file's entire job is to turn The Odds API's JSON
 * into `ParsedRow`s -- the identical shape `sources/propprofessor-screen.ts` produces -- so that
 * `buildClosingVerdict` can consume it unchanged. Both tabs of the modal then share the averaging,
 * the sportsbook allowlist, the outlier test and the renderers, which is what makes them genuinely
 * comparable: a difference between the tabs is a difference between the *sources*, never between
 * two of our own parsers. The main-line reconstruction is shared outright (`main-line.ts`).
 *
 * ## The response shape, as documented and verified
 *
 * The event listing (`/v4/sports/{sport}/events`) is bookmaker-free and costs no credits:
 *
 *   [{ id, sport_key, sport_title, commence_time, home_team, away_team }]
 *
 * The per-event odds call (`/v4/sports/{sport}/events/{id}/odds`) is bookmaker-major, and the
 * outcomes of one market are a *flat* list covering every player at once:
 *
 *   { id, home_team, away_team, bookmakers: [{ key, title, markets: [
 *       { key, last_update, outcomes: [{ name, description, price, point }] } ] }] }
 *
 * Three shape facts that drive the code below:
 *
 *  1. `name` is "Over"/"Under" on a player prop or a total, and a *team name* on h2h and spreads.
 *     `description` carries the player on a player prop and is absent otherwise. So the grouping
 *     key for "which selection is this" differs by market type, which `selectionKeyFor` handles.
 *  2. One bookmaker can appear with several `point` values for the same player inside the main
 *     market. That is the same alt-line situation the odds screen has, and it is resolved the same
 *     way -- `pickMainLines`.
 *  3. Prices are decimal unless `oddsFormat=american` is asked for. We always ask for American,
 *     because every downstream convention in this project is American.
 */

import { bookLogoUrl, normalizeBookKey } from "../books";
import type { ClosingWorkItem, MarketType, ParseResult, ParsedRow, PickSide } from "../types";
import {
  extractPeriod,
  marketFilterKey,
  normalizeMarketName,
  propProfessorLeague,
  NO_SPORTSBOOK_EQUIVALENT,
} from "../markets";
import { normalizeName } from "../matching";
import { devigTwoWay } from "../devig";
import { pickMainLines, type BookQuote } from "./main-line";

/** The API's own host. The only host this module ever names -- see `oddsjam-automation-guard`. */
export const ODDS_API_HOST = "https://api.the-odds-api.com";

/**
 * Where a human goes to read the same numbers.
 *
 * The Odds API has no odds screen of its own -- it is an API, not a site -- so unlike
 * `screenPageUrl` there is no deep link to the market being described. This is the standing link,
 * used to explain where the tab's numbers come from rather than to point at one market.
 */
export const ODDS_API_PAGE = "https://the-odds-api.com";

// --- vocabulary -------------------------------------------------------------------------------

/**
 * Our league code -> The Odds API sport key.
 *
 * Keyed by the output of `propProfessorLeague`, not by the board's raw sport text, so that every
 * spelling that resolver already understands ("college football", "Japan - NPB", "cfb") reaches
 * this table having been collapsed once. There is exactly one league vocabulary in this project and
 * this table is a translation of it, not a second one.
 *
 * Tennis, soccer, golf and MMA are absent on purpose rather than by oversight. The Odds API keys
 * those per *tournament or competition* -- `tennis_atp_wimbledon_singles`,
 * `soccer_epl`, `soccer_usa_mls` -- where our league vocabulary has collapsed all of them to one
 * code ("Tennis", "Soccer"), exactly because PropProfessor does too. Recovering the specific
 * tournament from a board that wrote "ATP" is not possible, and guessing one would silently answer
 * about the wrong event. An honest "this source does not cover it" is the correct outcome, and the
 * PropProfessor tab still answers these perfectly well.
 */
export const ODDS_API_SPORTS: Record<string, string> = {
  NFL: "americanfootball_nfl",
  NCAAF: "americanfootball_ncaaf",
  CFL: "americanfootball_cfl",
  NBA: "basketball_nba",
  NCAAB: "basketball_ncaab",
  WNBA: "basketball_wnba",
  NHL: "icehockey_nhl",
  MLB: "baseball_mlb",
};

/**
 * The bookmakers this source may be asked for, in the order they are preferred.
 *
 * ## Why there is a list at all, and why it is capped
 *
 * The Odds API charges `unique markets returned x regions`, and its `bookmakers` parameter takes
 * priority over `regions` at a rate of *one region per group of ten books*. So naming up to ten
 * bookmakers costs exactly one credit, and the eleventh doubles the price of every click. Asking by
 * region instead would cost four credits to reach the same books, because the ones worth having are
 * spread across four of them: `us` (FanDuel, DraftKings, BetMGM, Caesars, BetOnline),
 * `us2` (ESPN/theScore, Fliff, Hard Rock, Bally, betPARX, ReBet), `us_ex` (Novig, ProphetX, Kalshi,
 * Polymarket) and `eu` (Pinnacle). A curated ten is therefore both cheaper and better targeted.
 *
 * The order is the one that matters: `oddsApiBookmakers` below takes the first ten entries that
 * survive the user's own book ordering, so the books this install has ranked highest are the ones
 * the credit is spent on.
 *
 * Keys are The Odds API's; the value is the key this project already uses for the same book, so
 * `SPORTSBOOK_HINTS`, `DEFAULT_BOOK_ORDER`, `BOOK_DOMAINS` and the outlier test all apply with no
 * special-casing anywhere downstream.
 */
export const ODDS_API_BOOKS: Record<string, string> = {
  fanduel: "fanduel",
  pinnacle: "pinnacle",
  draftkings: "draftkings",
  betonlineag: "betonline",
  novig: "novig",
  prophetx: "prophet",
  polymarket: "polymarket",
  kalshi: "kalshi",
  betmgm: "betmgm",
  // The API's key is the old William Hill brand; the book is Caesars and its `title` says so.
  williamhill_us: "caesars",
  fanatics: "fanatics",
  betrivers: "betrivers",
  // Rebranded to theScore Bet, which is what `title` returns; both spellings are already in
  // `SPORTSBOOK_HINTS`, so either one is admitted to the average.
  espnbet: "espnbet",
  hardrockbet: "hardrock",
  fliff: "fliff",
  rebet: "rebet",
  ballybet: "ballybet",
  betparx: "betparx",
  bovada: "bovada",
  betopenly: "betopenly",
  courtside: "courtside",
  betus: "betus",
  lowvig: "lowvig",
  mybookieag: "mybookie",
  // DFS apps. Never averaged (`isSportsbookForClose` denies them) but worth *showing*: a DFS line
  // beside the sportsbook consensus is the comparison this modal exists to make.
  prizepicks: "prizepicks",
  underdog: "underdog",
  pick6: "draftkings6",
  dabble_us_dfs: "dabble",
};

/** This project's book key for one of The Odds API's, falling back to its own normalization. */
export function normalizeOddsApiBookKey(apiKey: string, title: string | null = null): string {
  return ODDS_API_BOOKS[apiKey] ?? normalizeBookKey(apiKey) ?? normalizeBookKey(title) ?? "unknown";
}

/**
 * The sport family a sport key belongs to, used to key the market tables below.
 *
 * Necessary because a bare stat name is ambiguous across sports and The Odds API's keys are not:
 * "strikeouts" is `batter_strikeouts` or `pitcher_strikeouts` in baseball and nothing at all
 * elsewhere, while "assists" is `player_assists` in three different sports that happen to agree on
 * the key. Keying the tables by family makes the collisions impossible rather than lucky.
 */
function sportFamily(sportKey: string): "football" | "basketball" | "baseball" | "hockey" | null {
  if (sportKey.startsWith("americanfootball_")) return "football";
  if (sportKey.startsWith("basketball_")) return "basketball";
  if (sportKey.startsWith("baseball_")) return "baseball";
  if (sportKey.startsWith("icehockey_")) return "hockey";
  return null;
}

/**
 * Captured market name -> The Odds API market key, per sport family.
 *
 * Deliberately its own table rather than another column bolted onto `PROPPROFESSOR_MARKETS`. The
 * two sources do not carry the same markets -- PropProfessor has "Player Tackles" and "Player First
 * Downs", this API has neither; this API has `player_pass_rush_reception_yds`, and the vocabularies
 * drift independently as each adds coverage. One table with holes in it would make a missing market
 * indistinguishable from a missing alias, which is exactly the distinction `resolveOddsApiMarket`
 * exists to keep.
 *
 * Keyed by `normalizeMarketName` output, with a `marketFilterKey` fallback at lookup time so the
 * bare and "player"-prefixed spellings both land without listing each twice.
 *
 * Verified against the published market list (the-odds-api.com/sports-odds-data/betting-markets).
 */
const ODDS_API_MARKETS: Record<string, Record<string, string>> = {
  football: {
    "passing yards": "player_pass_yds",
    "passing touchdowns": "player_pass_tds",
    "passing attempts": "player_pass_attempts",
    "passing completions": "player_pass_completions",
    interceptions: "player_pass_interceptions",
    "passing interceptions": "player_pass_interceptions",
    "defensive interceptions": "player_defensive_interceptions",
    "longest completion": "player_pass_longest_completion",
    "longest passing completion": "player_pass_longest_completion",
    "rushing yards": "player_rush_yds",
    "rushing attempts": "player_rush_attempts",
    "rushing touchdowns": "player_rush_tds",
    "longest rush": "player_rush_longest",
    "receiving yards": "player_reception_yds",
    receptions: "player_receptions",
    "receiving touchdowns": "player_reception_tds",
    "longest reception": "player_reception_longest",
    "rushing plus receiving yards": "player_rush_reception_yds",
    "rushing plus receiving touchdowns": "player_rush_reception_tds",
    "passing plus rushing yards": "player_pass_rush_yds",
    "passing plus rushing plus receiving yards": "player_pass_rush_reception_yds",
    "passing plus rushing plus receiving touchdowns": "player_pass_rush_reception_tds",
    "pass plus rush plus rec touchdowns": "player_pass_rush_reception_tds",
    "solo tackles": "player_solo_tackles",
    "tackles plus assists": "player_tackles_assists",
    // The API has no plain "tackles" market. `player_tackles_assists` is the closest thing any book
    // prices and is what the grading stat-map already treats as the same underlying stat.
    tackles: "player_tackles_assists",
    assists: "player_assists",
    sacks: "player_sacks",
    "field goals made": "player_field_goals",
    "kicking points": "player_kicking_points",
    "pat made": "player_pats",
    "extra points made": "player_pats",
    touchdowns: "player_tds",
    "anytime touchdown": "player_anytime_td",
    "anytime touchdown scorer": "player_anytime_td",
    "first touchdown scorer": "player_1st_td",
    "last touchdown scorer": "player_last_td",
  },
  basketball: {
    points: "player_points",
    rebounds: "player_rebounds",
    assists: "player_assists",
    "threes made": "player_threes",
    "three pointers made": "player_threes",
    "3 pointers made": "player_threes",
    "made threes": "player_threes",
    blocks: "player_blocks",
    steals: "player_steals",
    "blocks plus steals": "player_blocks_steals",
    "blks plus stls": "player_blocks_steals",
    turnovers: "player_turnovers",
    "points plus rebounds plus assists": "player_points_rebounds_assists",
    "pts plus reb plus ast": "player_points_rebounds_assists",
    "points plus rebounds": "player_points_rebounds",
    "points plus assists": "player_points_assists",
    "rebounds plus assists": "player_rebounds_assists",
    "field goals made": "player_field_goals",
    "free throws made": "player_frees_made",
    "free throws attempted": "player_frees_attempts",
    "double double": "player_double_double",
    "triple double": "player_triple_double",
  },
  baseball: {
    "home runs": "batter_home_runs",
    hits: "batter_hits",
    "total bases": "batter_total_bases",
    rbis: "batter_rbis",
    "runs batted in": "batter_rbis",
    "runs scored": "batter_runs_scored",
    runs: "batter_runs_scored",
    "hits plus runs plus rbis": "batter_hits_runs_rbis",
    singles: "batter_singles",
    doubles: "batter_doubles",
    triples: "batter_triples",
    walks: "batter_walks",
    "stolen bases": "batter_stolen_bases",
    strikeouts: "batter_strikeouts",
    "batter strikeouts": "batter_strikeouts",
    // "Pitcher " is never stripped by `marketFilterKey`, precisely so these stay distinct from the
    // batter markets of the same name.
    "pitcher strikeouts": "pitcher_strikeouts",
    "pitcher hits allowed": "pitcher_hits_allowed",
    "pitcher walks": "pitcher_walks",
    "pitcher earned runs": "pitcher_earned_runs",
    "pitcher outs": "pitcher_outs",
    "earned runs": "pitcher_earned_runs",
    outs: "pitcher_outs",
  },
  hockey: {
    points: "player_points",
    assists: "player_assists",
    goals: "player_goals",
    "shots on goal": "player_shots_on_goal",
    shots: "player_shots_on_goal",
    "blocked shots": "player_blocked_shots",
    saves: "player_total_saves",
    "total saves": "player_total_saves",
    "power play points": "player_power_play_points",
    "anytime goal scorer": "player_goal_scorer_anytime",
  },
};

/**
 * Player-prop markets that have a 1st-quarter variant, by family.
 *
 * This is the whole of the API's period coverage for player props: a `_q1` suffix on four markets,
 * and nothing else. There is no 1st-half player prop, no 2nd quarter, no period, no inning -- which
 * matters because our own vocabulary happily produces all of those (`extractPeriod` understands
 * "1st Half", "3rd Period", "1st 5 Innings", because PropProfessor's screen carries them). A
 * period-qualified prop this API cannot express must say so rather than quietly answering about the
 * full game, which would be the same class of bug as answering about the wrong market entirely.
 *
 * Game markets are the opposite case and are handled in `gameMarketKey` below: h2h, spreads, totals
 * and team totals carry the full range of period suffixes.
 */
const PLAYER_PROP_Q1_MARKETS: Record<string, string[]> = {
  football: ["player_pass_yds"],
  basketball: ["player_points", "player_rebounds", "player_assists"],
};

/**
 * Our period label -> The Odds API's market-key suffix, for game markets.
 *
 * `extractPeriod` returns PropProfessor's own spellings ("1st Quarter", "1st 5 Innings") because
 * that is the vocabulary it was written against; this is the translation into the suffixes this API
 * documents. Absent entries are genuinely absent from the API -- there is no 2nd-set suffix on
 * totals, for instance -- and resolve to an honest "not carried" rather than a dropped qualifier.
 */
const PERIOD_SUFFIXES: Record<string, string> = {
  "1st Quarter": "_q1",
  "2nd Quarter": "_q2",
  "3rd Quarter": "_q3",
  "4th Quarter": "_q4",
  "1st Half": "_h1",
  "2nd Half": "_h2",
  "1st Period": "_p1",
  "2nd Period": "_p2",
  "3rd Period": "_p3",
  "1st Inning": "_1st_1_innings",
  "1st 1 Innings": "_1st_1_innings",
  "1st 3 Innings": "_1st_3_innings",
  "1st 5 Innings": "_1st_5_innings",
  "1st 7 Innings": "_1st_7_innings",
  "1st Set": "_s1",
  "2nd Set": "_s2",
};

/** Period suffixes each game market actually carries, so an unsupported pairing is caught here. */
const GAME_MARKET_PERIODS: Record<string, string[]> = {
  h2h: ["_q1", "_q2", "_q3", "_q4", "_h1", "_h2", "_p1", "_p2", "_p3", "_1st_1_innings", "_1st_3_innings", "_1st_5_innings", "_1st_7_innings", "_s1", "_s2"],
  spreads: ["_q1", "_q2", "_q3", "_q4", "_h1", "_h2", "_p1", "_p2", "_p3", "_1st_1_innings", "_1st_3_innings", "_1st_5_innings", "_1st_7_innings", "_s1"],
  totals: ["_q1", "_q2", "_q3", "_q4", "_h1", "_h2", "_p1", "_p2", "_p3", "_1st_1_innings", "_1st_3_innings", "_1st_5_innings", "_1st_7_innings", "_s1"],
  team_totals: ["_q1", "_q2", "_q3", "_q4", "_h1", "_h2", "_p1", "_p2", "_p3"],
};

export type ResolvedOddsApiMarket =
  | { ok: true; sportKey: string; market: string }
  /** Knowably unpriceable, or not carried by this source at all. Terminal, and not a failure. */
  | { ok: false; kind: "noEquivalent"; detail: string }
  /** We simply have no mapping yet. Must stay loud so a line can be added to the table. */
  | { ok: false; kind: "unmapped"; detail: string };

/** The base game-market key for a market type, or null when it is not a game market. */
function gameMarketKey(marketType: MarketType, stat: string): string | null {
  if (marketType === "MONEYLINE") return "h2h";
  if (marketType === "SPREAD") return "spreads";
  if (stat === "team total" || stat === "team totals" || stat.startsWith("team total ")) {
    return "team_totals";
  }
  if (marketType === "GAME_TOTAL") return "totals";
  return null;
}

/**
 * Decides what to ask The Odds API for, or why it cannot be asked.
 *
 * The three outcomes mirror `resolveClosingMarket`'s exactly, for the same reason it has them:
 * collapsing "this source does not carry it" into "we could not find it" hides a real answer, and
 * collapsing "we have no alias yet" into either hides the one maintenance task this table carries.
 */
export function resolveOddsApiMarket(
  sport: string | null,
  statMarket: string | null,
  marketType: MarketType = "PLAYER_PROP"
): ResolvedOddsApiMarket {
  const rawStat = normalizeMarketName(statMarket);
  if (!rawStat) return { ok: false, kind: "unmapped", detail: "the pick has no market name" };

  const { base: stat, period } = extractPeriod(rawStat);

  if (NO_SPORTSBOOK_EQUIVALENT.some((re) => re.test(stat))) {
    return {
      ok: false,
      kind: "noEquivalent",
      detail: `"${statMarket}" is a DFS-only market that no sportsbook prices`,
    };
  }

  const league = propProfessorLeague(sport);
  if (!league) {
    return { ok: false, kind: "unmapped", detail: `no league recognised for sport "${sport}"` };
  }
  const sportKey = ODDS_API_SPORTS[league];
  if (!sportKey) {
    return {
      ok: false,
      kind: "noEquivalent",
      detail: `The Odds API has no single sport key for ${league} -- it keys that sport by individual tournament or competition, which a board's "${sport}" does not name`,
    };
  }
  const family = sportFamily(sportKey);
  if (!family) {
    return { ok: false, kind: "unmapped", detail: `no market table for sport key "${sportKey}"` };
  }

  const suffix = period === null ? "" : PERIOD_SUFFIXES[period];
  if (period !== null && suffix === undefined) {
    return {
      ok: false,
      kind: "noEquivalent",
      detail: `The Odds API has no "${period}" markets`,
    };
  }

  // --- game markets ---------------------------------------------------------------------------
  const gameKey = gameMarketKey(marketType, stat);
  if (gameKey) {
    if (suffix && !GAME_MARKET_PERIODS[gameKey].includes(suffix)) {
      return {
        ok: false,
        kind: "noEquivalent",
        detail: `The Odds API carries no ${period} variant of this market`,
      };
    }
    return { ok: true, sportKey, market: `${gameKey}${suffix}` };
  }

  // --- player props ---------------------------------------------------------------------------
  const table = ODDS_API_MARKETS[family];
  const market = table[stat] ?? table[marketFilterKey(stat)];
  if (!market) {
    return {
      ok: false,
      kind: "unmapped",
      detail: `no Odds API market for "${statMarket}" in ${league}`,
    };
  }

  if (suffix) {
    // Deliberately not silently dropped. Answering a "1st Half Receiving Yards" pick with the
    // full-game market would look exactly like a successful read and be wrong by a whole game.
    if (suffix !== "_q1" || !(PLAYER_PROP_Q1_MARKETS[family] ?? []).includes(market)) {
      return {
        ok: false,
        kind: "noEquivalent",
        detail: `The Odds API carries no ${period} variant of this player prop -- its only period player props are 1st-quarter passing yards, points, rebounds and assists`,
      };
    }
    return { ok: true, sportKey, market: `${market}_q1` };
  }

  return { ok: true, sportKey, market };
}

// --- request planning -------------------------------------------------------------------------

export interface OddsApiReadPlan {
  sportKey: string;
  /** One market key. One market is one credit -- see `ODDS_API_BOOKS`. */
  market: string;
  /** At most ten, so the request costs exactly one credit. */
  bookmakers: string[];
  /** The market name as the *pick* spells it, kept so parsed rows speak the caller's vocabulary. */
  requestedStatMarket: string;
  marketType: MarketType;
}

export interface UnplannableOddsApiRead {
  /** `noEquivalent` is terminal and blameless; `unmapped` is a gap in our alias table. */
  kind: "noEquivalent" | "unmapped";
  reason: string;
}

/**
 * The most credits one modal click may cost.
 *
 * One, and the design holds it there: one market key, and at most ten bookmakers (which the API
 * bills as a single region). Stated as a named constant because it is the number the whole shape of
 * this module is arranged around, and a future edit that adds a second market key or an eleventh
 * book would silently double every user's spend against a free 500/month quota.
 */
export const ODDS_API_COST_PER_READ = 1;

/** The API bills bookmakers in groups of ten; one group is one region, which is one credit. */
export const ODDS_API_MAX_BOOKMAKERS = 10;

/**
 * Which bookmakers to spend the credit on, honouring the user's own book ordering.
 *
 * `bookOrder` is the list from Settings -- the same one that orders every table in the app -- so
 * the books someone has ranked to the top are the ones actually requested. Books it does not
 * mention keep `ODDS_API_BOOKS`' own order behind them, so a fresh install with no preferences
 * still asks for a sensible ten rather than an arbitrary ten.
 */
export function oddsApiBookmakers(bookOrder: string[] = []): string[] {
  const apiKeys = Object.keys(ODDS_API_BOOKS);
  // First occurrence wins. `new Map(entries)` would keep the *last*, which silently inverts the
  // intent whenever a key appears twice -- and it does: promoting a book by prepending it to the
  // stored order leaves the original entry further down the list.
  const rank = new Map<string, number>();
  bookOrder.forEach((key, i) => {
    if (!rank.has(key)) rank.set(key, i);
  });
  return [...apiKeys]
    .sort((a, b) => {
      const ra = rank.get(ODDS_API_BOOKS[a]);
      const rb = rank.get(ODDS_API_BOOKS[b]);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return apiKeys.indexOf(a) - apiKeys.indexOf(b);
    })
    .slice(0, ODDS_API_MAX_BOOKMAKERS);
}

/**
 * What to ask The Odds API for, or why this pick cannot be asked about.
 *
 * Like `planScreenRead`, `item.pageUrl` is never consulted: provenance is not a read target. The
 * only inputs are the sport, the market and the market type.
 */
export function planOddsApiRead(
  item: Pick<ClosingWorkItem, "sport" | "statMarket" | "marketType">,
  options: { bookOrder?: string[] } = {}
): OddsApiReadPlan | UnplannableOddsApiRead {
  const resolved = resolveOddsApiMarket(item.sport, item.statMarket, item.marketType);
  if (!resolved.ok) return { kind: resolved.kind, reason: resolved.detail };

  return {
    sportKey: resolved.sportKey,
    market: resolved.market,
    bookmakers: oddsApiBookmakers(options.bookOrder),
    requestedStatMarket: item.statMarket,
    marketType: item.marketType,
  };
}

/** The (free) event-listing URL for a plan's sport. */
export function oddsApiEventsUrl(plan: OddsApiReadPlan, apiKey: string): string {
  const params = new URLSearchParams({ apiKey, dateFormat: "iso" });
  return `${ODDS_API_HOST}/v4/sports/${plan.sportKey}/events?${params.toString()}`;
}

/** The per-event odds URL. This is the call that costs the credit. */
export function oddsApiOddsUrl(plan: OddsApiReadPlan, eventId: string, apiKey: string): string {
  const params = new URLSearchParams({
    apiKey,
    markets: plan.market,
    bookmakers: plan.bookmakers.join(","),
    oddsFormat: "american",
    dateFormat: "iso",
  });
  return `${ODDS_API_HOST}/v4/sports/${plan.sportKey}/events/${eventId}/odds?${params.toString()}`;
}

// --- event resolution -------------------------------------------------------------------------

export interface OddsApiEvent {
  id: string;
  sport_key?: unknown;
  sport_title?: unknown;
  commence_time?: unknown;
  home_team?: unknown;
  away_team?: unknown;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Splits "Boston College vs. Rutgers" / "Rutgers @ Boston College" into its two normalized sides. */
function matchupSides(matchup: string | null): string[] {
  if (!matchup) return [];
  return matchup
    .split(/\s+(?:vs\.?|v\.?|@|at)\s+/i)
    .map((s) => normalizeName(s))
    .filter(Boolean);
}

/** True when a normalized board team name and an API team name are plausibly the same club. */
function sameTeam(boardTeam: string, apiTeam: string): boolean {
  if (!boardTeam || !apiTeam) return false;
  if (boardTeam === apiTeam) return true;
  if (apiTeam.includes(boardTeam) || boardTeam.includes(apiTeam)) return true;
  // "LA Rams" vs "Los Angeles Rams": the nickname is the last word and is what actually identifies
  // a club, since the city is exactly the part the boards abbreviate inconsistently.
  const boardWords = boardTeam.split(" ");
  const apiWords = apiTeam.split(" ");
  const boardNick = boardWords[boardWords.length - 1];
  const apiNick = apiWords[apiWords.length - 1];
  return boardNick.length > 3 && boardNick === apiNick;
}

/**
 * Which listed event a pick is about.
 *
 * This is the integration risk the whole design turns on: unlike PropProfessor's screen, which is
 * asked for a whole market at once and hands back its own game ids, this API needs an event id
 * *before* it will quote anything -- and the only thing our pick carries is a matchup written in
 * whatever prose its board used. So the match is made on team names, which are exactly the strings
 * the boards spell inconsistently.
 *
 * Both sides must match, and a pick whose matchup names only one recognisable team is not matched
 * at all. Returning the wrong event is far worse than returning none: the market would parse
 * perfectly and describe a different game.
 */
export function findOddsApiEvent(
  events: OddsApiEvent[],
  target: { matchup: string | null; subjectTeam: string | null }
): OddsApiEvent | null {
  const sides = matchupSides(target.matchup);
  const subject = normalizeName(target.subjectTeam);

  const candidates = events.filter((event) => {
    const home = normalizeName(str(event.home_team));
    const away = normalizeName(str(event.away_team));
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

  // Ambiguity is a failure, not a coin toss: two fixtures matching one matchup means the team names
  // did not actually identify a game, and picking the first would be picking at random.
  return candidates.length === 1 ? candidates[0] : null;
}

// --- response parsing -------------------------------------------------------------------------

interface RawOutcome {
  name?: unknown;
  description?: unknown;
  price?: unknown;
  point?: unknown;
}

interface RawMarket {
  key?: unknown;
  last_update?: unknown;
  outcomes?: unknown;
}

interface RawBookmaker {
  key?: unknown;
  title?: unknown;
  markets?: unknown;
}

interface RawEventOdds {
  id?: unknown;
  sport_key?: unknown;
  sport_title?: unknown;
  commence_time?: unknown;
  home_team?: unknown;
  away_team?: unknown;
  bookmakers?: unknown;
}

/**
 * The two sides of the market, as `outcome.name` spells them.
 *
 * On a player prop or a total they are literally "Over" and "Under". On h2h and spreads they are
 * the two team names, so the sides are the fixture's own teams and the "side" concept collapses
 * into which team the row is about -- the same convention `buildRow` uses on the screen parser.
 */
function sidesFor(marketType: MarketType, home: string | null, away: string | null): [string, string] {
  return marketType === "MONEYLINE" || marketType === "SPREAD"
    ? [home ?? "Home", away ?? "Away"]
    : ["Over", "Under"];
}

/**
 * What distinguishes one selection from another within a market.
 *
 * A player prop's outcomes are a flat list covering every player in the game, so the player
 * (`description`) is the selection. A game total has exactly one selection and no description at
 * all. A team total has one per team, and the API puts the team in `description` there too.
 */
function selectionKeyFor(outcome: RawOutcome, marketType: MarketType): string {
  if (marketType === "MONEYLINE" || marketType === "SPREAD") return "";
  return str(outcome.description) ?? "";
}

/**
 * Turns one event's odds response into rows the existing matcher and verdict builder understand.
 *
 * Emits one row per (selection, side): a player prop becomes an OVER row and an UNDER row per
 * player, because `findMatchingRow` identifies a prop by player + stat + side. A game market
 * becomes one row per team. Identical to what the screen parser emits, deliberately.
 *
 * Never throws -- a malformed payload returns `{ ok: false, reason }` the same way every other
 * parser in this project does.
 */
export function normalizeOddsApiEvent(
  raw: unknown,
  plan: OddsApiReadPlan,
  options: { atLine?: number | null } = {}
): ParseResult {
  try {
    const body = raw as RawEventOdds;
    if (!body || typeof body !== "object") {
      return { ok: false, reason: "the odds response was not an object", headers: [], rows: [] };
    }
    const bookmakers = body.bookmakers;
    if (!Array.isArray(bookmakers)) {
      return { ok: false, reason: "response had no bookmakers array", headers: [], rows: [] };
    }

    const home = str(body.home_team);
    const away = str(body.away_team);
    const isGameMarket = plan.marketType === "MONEYLINE" || plan.marketType === "SPREAD";
    // A moneyline has no line to ask about: its "line" is its price, so an alt-line lookup there
    // would be comparing a price against itself.
    const atLine =
      plan.marketType === "MONEYLINE" || typeof options.atLine !== "number" ? null : options.atLine;

    const [sideOneName, sideTwoName] = sidesFor(plan.marketType, home, away);

    /**
     * Quotes grouped by selection, then by which side they price.
     *
     * Built in one pass over a response that is bookmaker-major, because the rows we need are
     * selection-major -- every book's opinion of one player has to end up in one place.
     */
    const bySelection = new Map<string, { one: BookQuote[]; two: BookQuote[] }>();
    // Markets the response carries that we did not ask for. The API echoes the requested key, so a
    // disagreement means it answered about something else and the row would be wrong.
    const wrongMarkets = new Set<string>();

    for (const bookmaker of bookmakers as RawBookmaker[]) {
      if (!bookmaker || typeof bookmaker !== "object") continue;
      const apiKey = str(bookmaker.key);
      if (!apiKey) continue;
      const title = str(bookmaker.title);
      const markets = bookmaker.markets;
      if (!Array.isArray(markets)) continue;

      for (const market of markets as RawMarket[]) {
        if (!market || typeof market !== "object") continue;
        const key = str(market.key);
        if (key !== null && key !== plan.market) {
          wrongMarkets.add(key);
          continue;
        }
        const outcomes = market.outcomes;
        if (!Array.isArray(outcomes)) continue;

        // One book's outcomes for one selection at one line: the two sides arrive as separate
        // entries and have to be paired before either is usable, since a de-vig needs both and the
        // main-line choice is made from both.
        type Pair = { one: RawOutcome | null; two: RawOutcome | null };
        const pairs = new Map<string, Pair>();
        for (const outcome of outcomes as RawOutcome[]) {
          if (!outcome || typeof outcome !== "object") continue;
          const name = str(outcome.name);
          if (!name) continue;
          // An outcome naming neither side is not part of this market as we model it (a 3-way
          // h2h's "Draw", say), and has no row to go in.
          const side = name === sideOneName ? 1 : name === sideTwoName ? 2 : null;
          if (side === null) continue;

          const selection = selectionKeyFor(outcome, plan.marketType);
          const point = num(outcome.point);
          // Keyed on the line as well as the selection: a book quoting 14.5 and 15.5 for one player
          // must not have its Over 14.5 paired with its Under 15.5.
          const pairKey = `${selection}::${point ?? "null"}`;
          const pair = pairs.get(pairKey) ?? { one: null, two: null };
          if (side === 1) pair.one = outcome;
          else pair.two = outcome;
          pairs.set(pairKey, pair);
        }

        for (const [pairKey, pair] of pairs) {
          const selection = pairKey.slice(0, pairKey.lastIndexOf("::"));
          const priceOne = num(pair.one?.price);
          const priceTwo = num(pair.two?.price);
          if (priceOne === null && priceTwo === null) continue;

          const lineOne = num(pair.one?.point);
          const lineTwo = num(pair.two?.point);
          const bucket = bySelection.get(selection) ?? { one: [], two: [] };
          const bookKey = normalizeOddsApiBookKey(apiKey, title);
          const label = title ?? apiKey;

          // Each side keeps its *own* point. On a prop the two agree, but a spread quotes +7 to one
          // team and -7 to the other in the same pairing -- the same trap the screen parser calls
          // out, and the reason neither side may borrow the other's number.
          bucket.one.push({
            bookKey,
            label,
            // A moneyline has no number to move, so the price is the tracked line -- the convention
            // every other parser in this project uses, which keeps computeClv's arithmetic intact.
            line: plan.marketType === "MONEYLINE" ? priceOne : (lineOne ?? lineTwo),
            price: priceOne,
            otherSidePrice: priceTwo,
            // The API publishes no depth on this endpoint (`includeBetLimits` is a separate paid
            // add-on we do not request), so this is genuinely unknown rather than zero.
            liquidity: null,
          });
          bucket.two.push({
            bookKey,
            label,
            line: plan.marketType === "MONEYLINE" ? priceTwo : (lineTwo ?? lineOne),
            price: priceTwo,
            otherSidePrice: priceOne,
            liquidity: null,
          });
          bySelection.set(selection, bucket);
        }
      }
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
          eventId: str(body.id),
          commenceTime: str(body.commence_time),
          sportTitle: str(body.sport_title),
        });
        if (row) rows.push(row);
      }
    }

    if (rows.length === 0 && wrongMarkets.size > 0) {
      return {
        ok: false,
        reason:
          `asked for "${plan.market}" and the API answered about ` +
          `${[...wrongMarkets].map((m) => `"${m}"`).join(", ")}`,
        headers: [],
        rows: [],
      };
    }

    return {
      ok: true,
      headers: [plan.sportKey, plan.market],
      rows,
      reason: rows.length === 0 ? "the market returned no priced selections" : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "could not read the odds response",
      headers: [],
      rows: [],
    };
  }
}

function buildRow(input: {
  plan: OddsApiReadPlan;
  selection: string;
  quotes: BookQuote[];
  side: 1 | 2;
  sideName: string;
  home: string | null;
  away: string | null;
  rowIndex: number;
  atLine: number | null;
  eventId: string | null;
  commenceTime: string | null;
  sportTitle: string | null;
}): ParsedRow | null {
  const { plan, selection, side, sideName, home, away, atLine } = input;
  const books = pickMainLines(input.quotes, atLine);
  if (books.size === 0) return null;

  const isGameMarket = plan.marketType === "MONEYLINE" || plan.marketType === "SPREAD";
  const pickSide: PickSide | null = isGameMarket ? null : side === 1 ? "OVER" : "UNDER";

  const bookLines = [...books.entries()]
    // A moneyline's tracked line IS its price, so a book that does not price this team has nothing
    // to contribute; on every other market the line stands on its own.
    .filter(([, b]) => plan.marketType !== "MONEYLINE" || b.price !== null)
    // A prop or spread whose best price is nowhere near even money is not a line anyone is really
    // offering -- typically one resting order on an exchange, where a -1000 quote against a field
    // at -110 can sit untaken indefinitely. Never applied to moneylines, where -1000 is an ordinary
    // price for a heavy favourite.
    .filter(([, b]) => plan.marketType === "MONEYLINE" || b.nearMarket)
    // The key is the one `pickMainLines` grouped on, which is `ODDS_API_BOOKS`' translation into
    // this project's own vocabulary -- deliberately not re-derived from the label here, because
    // "theScore Bet" and "Caesars" normalize to keys the book order has never heard of.
    .map(([bookKey, b]) => {
      const alts = b.selectionsSeen.filter((l) => l !== b.line);
      return {
        bookKey,
        label: b.label,
        line: b.line,
        price: b.price,
        // This endpoint publishes no depth -- see the `liquidity: null` above.
        liquidity: null,
        // This book's own no-vig probability for the side taken, where it priced both sides. The
        // consensus of these is formed downstream, over exactly the books that survive the
        // sportsbook allowlist and the outlier test.
        fairProbability: devigTwoWay(b.price, b.otherSidePrice),
        priceAtLine: b.priceAtLine,
        // JSON, so there is no logo to scrape -- it is looked up from the book's key, exactly as on
        // the screen path, which is what makes both tabs render the same icons.
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

  // A team total names its team in `description`, the same field a player prop names its player in.
  const isTeamTotal = plan.market.startsWith("team_totals");

  return {
    rowIndex: input.rowIndex,
    marketType: plan.marketType,
    player: isGameMarket || isTeamTotal ? null : (selection || null),
    selectionName: isGameMarket ? sideName : selection || sideName,
    subjectTeam: isGameMarket ? sideName : isTeamTotal ? selection || null : null,
    // The per-event endpoint carries pre-match and in-play alike with no flag distinguishing them;
    // `commence_time` in the past is the only signal, and the caller already filters on it.
    isLive: false,
    team: home,
    opponent: away,
    matchup: home && away ? `${away} vs ${home}` : null,
    sport: input.sportTitle,
    // Deliberately the market name as the *pick* spells it, not the API's key. The alias table
    // asserts the two name one market, so translating here is what lets the shared matcher keep
    // working unchanged.
    statMarket: plan.requestedStatMarket,
    side: pickSide,
    takenLine,
    // No row-level de-vigged probability, for the same reason the screen parser leaves this null:
    // the honest consensus can only be taken after the allowlist and the outlier test have run,
    // which happens in `buildClosingVerdict`. One closing fair probability, not two that disagree.
    fairProbability: null,
    boardEvPercent: null,
    gameStartTimeText: input.commenceTime,
    gameStartTimeIso: input.commenceTime,
    // The API publishes no per-selection id; the event id is the only identifier it gives back.
    externalPropId: null,
    externalPlayerId: null,
    externalGameId: input.eventId,
    bookLines,
    rawText: JSON.stringify({
      source: "odds-api-event",
      sportKey: plan.sportKey,
      market: plan.market,
      eventId: input.eventId,
      selection,
      bookCount: bookLines.length,
    }),
  };
}
