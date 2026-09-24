/**
 * Planning a read of Odds Terminal: which books to ask for, which slate to ask about, and which
 * market names count as an answer.
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is a **pure planner**. It names no host, opens no connection and never sees a response. Every
 * path it produces is relative by construction, so nothing that imports it can be turned into
 * outbound traffic by accident -- the origin is added in exactly one place
 * (`extension/src/background/odds-terminal-read.ts`), and `oddsjam-automation-guard.test.ts` scans
 * this whole directory to keep it that way.
 *
 * ## The two requests a lookup makes, and why it is two
 *
 * `/api/snapshot` answers two completely different questions depending on whether it is given a
 * `fixture_id`, and that shape is the whole design:
 *
 *   1. **Without** one (`oddsTerminalFixturesPath`) it lists the slate -- fixtures plus their main
 *      markets. This is how a pick's game is found; there is no other way to learn a fixture id.
 *   2. **With** one (`oddsTerminalOddsPath`) it returns *every* market that fixture has, player
 *      props included -- 2,300+ entries across 112 markets for one NFL game, verified live
 *      (2026-09-24). No second endpoint, no stream, no market table.
 *
 * That second point is worth stating plainly because the previous implementation was built on the
 * opposite belief. It read `/api/snapshot` without a fixture id, concluded the endpoint "serves
 * main markets only", and went looking for player props on the Server-Sent Events endpoint
 * (`/api/stream`) instead -- which, asked the same question, answers 200 and then sends nothing at
 * all for as long as anything listens. Every prop lookup timed out. Passing `fixture_id` is the
 * entire difference between the two behaviours.
 *
 * ## Three things the endpoint does that have to be planned around
 *
 *  - **Five books, hard.** Six is `400 Choose between one and five sportsbooks.`, not a truncation.
 *  - **The slate is 36 hours unless you say otherwise.** `start_date_after`/`start_date_before`
 *    (ISO timestamps, the site's own "Next 7 days" control) are what widen it. Without them a
 *    Sunday NFL slate is invisible on a Wednesday, which is most of the week.
 *  - **The slate is paginated at 100.** A 7-day NCAAF slate is 121 fixtures over two pages, so a
 *    single-page read silently cannot find a fifth of college games.
 */

import type { MarketType } from "../types";
import { normalizeBookKey } from "../books";
import {
  extractPeriod,
  marketFilterKey,
  normalizeMarketName,
  propProfessorLeague,
  resolveClosingMarket,
} from "../markets";
import { normalizeName } from "../matching";

// --- vocabulary -------------------------------------------------------------------------------

/**
 * Our league code -> Odds Terminal's `sport` query value and its own league id.
 *
 * The `sport` value is what the endpoint is keyed by; the `league` is both a query filter and what
 * a returned fixture carries in `league.id`, which is how a multi-league sport ("football" covers
 * NFL, NCAAF and CFL at once) is narrowed to the one the pick is about.
 *
 * Tennis, soccer, golf and MMA are absent for the same reason they are absent from
 * `ODDS_API_SPORTS`: our league vocabulary collapses every tournament into one code, and a source
 * that keys them per competition cannot be asked about "Tennis" without guessing which event. An
 * honest "not covered" beats an answer about the wrong match.
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
 * Every book has a lowercase `id` and a display `name`, and **they are not interchangeable**: the
 * `sportsbook=` query parameter takes the id, while `odds[].sportsbook` in the response comes back
 * as the name. So the query is built from `id` and the parse is keyed on `name`.
 *
 * Every id below was read out of a live `/api/catalog?sport=<sport>` response (2026-09-24), which
 * is the only way to get them right: they are not guessable (`hard_rock` with the underscore,
 * `polymarket_usa_` with the trailing one, `circa_sports`, and `bet365` lowercase in both fields).
 * ESPN BET and Underdog are absent because that catalog does not carry them -- ESPN BET is in its
 * `missing` list -- and asking for a book the endpoint does not know burns one of only five slots.
 *
 * `key` is the key this project already uses for the same book, so `SPORTSBOOK_HINTS`,
 * `BOOK_DOMAINS`, the book order and the outlier test all apply downstream with no special-casing.
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
  { id: "draftkings", name: "DraftKings", key: "draftkings" },
  { id: "fanduel", name: "FanDuel", key: "fanduel" },
  { id: "bet365", name: "bet365", key: "bet365" },
  { id: "betmgm", name: "BetMGM", key: "betmgm" },
  { id: "caesars", name: "Caesars", key: "caesars" },
  { id: "novig", name: "Novig", key: "novig" },
  { id: "fanatics", name: "Fanatics", key: "fanatics" },
  { id: "betrivers", name: "BetRivers", key: "betrivers" },
  { id: "hard_rock", name: "Hard Rock", key: "hardrock" },
  { id: "pinnacle", name: "Pinnacle", key: "pinnacle" },
  { id: "circa_sports", name: "Circa Sports", key: "circa" },
  { id: "betonline", name: "BetOnline", key: "betonline" },
  { id: "bovada", name: "Bovada", key: "bovada" },
  { id: "fliff", name: "Fliff", key: "fliff" },
  { id: "prophet_x", name: "Prophet X", key: "prophet" },
  { id: "kalshi", name: "Kalshi", key: "kalshi" },
  { id: "polymarket_usa_", name: "Polymarket (USA)", key: "polymarketus" },
  // DFS/pickem. Never averaged (`isSportsbookForClose` denies them), but worth showing: a DFS line
  // beside the sportsbook consensus is the comparison the Odds modal exists to make.
  { id: "prizepicks", name: "PrizePicks", key: "prizepicks" },
  { id: "sleeper", name: "Sleeper", key: "sleeper" },
];

/** Display name -> our book key, for reading a response. */
const BOOK_KEY_BY_NAME = new Map(ODDS_TERMINAL_BOOKS.map((b) => [b.name, b.key]));

/** The endpoint's own ceiling: more than five `sportsbook` params is a 400, not a truncation. */
export const ODDS_TERMINAL_MAX_BOOKS = 5;

/**
 * How many chunks of five a lookup may work through before giving up.
 *
 * A second chunk exists because the user's book ranking is not a ranking of *prop* coverage, and on
 * this feed those are very different things: on one NFL game (2026-09-24) DraftKings quoted 20
 * player markets and FanDuel 13, while Pinnacle, BetOnline and Circa -- three books ranked high in
 * this install -- quoted **none at all**. Ranking alone would spend three of five slots on books
 * that cannot answer the question being asked. So a chunk that comes back thin is followed by the
 * next one, and the results are merged. Three is the cap: fifteen books is already more than any
 * verdict needs, and each chunk is a request against a site this project is careful with.
 */
export const ODDS_TERMINAL_MAX_BOOK_CHUNKS = 3;

/** How wide the slate request is when the pick's own kickoff time is unknown. */
export const ODDS_TERMINAL_WINDOW_DAYS = 7;

/** The slate's page size, and therefore how many pages a big college slate needs. */
export const ODDS_TERMINAL_MAX_FIXTURE_PAGES = 4;

/** This project's book key for one of Odds Terminal's display names. */
export function normalizeOddsTerminalBookKey(sportsbook: string): string {
  return BOOK_KEY_BY_NAME.get(sportsbook) ?? normalizeBookKey(sportsbook) ?? "unknown";
}

/**
 * Every supported book, ranked by the user's own book order.
 *
 * Identical in spirit to `oddsApiBookmakers`: the install's ranking decides who is asked first, and
 * anything the user has not ranked falls in behind in this table's own order.
 */
function rankedBooks(bookOrder: string[]): OddsTerminalBook[] {
  const rank = new Map(bookOrder.map((key, index) => [key, index]));
  return [...ODDS_TERMINAL_BOOKS].sort((a, b) => {
    const ra = rank.get(a.key) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.key) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return ODDS_TERMINAL_BOOKS.indexOf(a) - ODDS_TERMINAL_BOOKS.indexOf(b);
  });
}

/**
 * The books to ask for, as `/api/snapshot` wants them (lowercase ids), in chunks of five.
 *
 * A chunk is one request. The caller works through them until the market it wants is covered --
 * see `ODDS_TERMINAL_MAX_BOOK_CHUNKS` for why more than one exists at all.
 */
export function oddsTerminalBookChunks(bookOrder: string[] = []): string[][] {
  const ranked = rankedBooks(bookOrder).map((b) => b.id);
  const chunks: string[][] = [];
  for (let i = 0; i < ranked.length && chunks.length < ODDS_TERMINAL_MAX_BOOK_CHUNKS; i += ODDS_TERMINAL_MAX_BOOKS) {
    chunks.push(ranked.slice(i, i + ODDS_TERMINAL_MAX_BOOKS));
  }
  return chunks;
}

/** The first chunk on its own, which is what a single-request read asks for. */
export function oddsTerminalBooks(bookOrder: string[] = []): string[] {
  return oddsTerminalBookChunks(bookOrder)[0] ?? [];
}

/**
 * The game markets each sport family actually offers, straight from live responses.
 *
 * Names, not ids. Matching happens on the feed's own display name for every market -- game markets
 * and player props alike -- because a fixture read returns all of them and the display name is the
 * one field that is stable, readable and shared with the vocabulary this project already has.
 * Verified live (2026-09-24): football and basketball quote "Point Spread"/"Total Points", baseball
 * "Run Line"/"Total Runs", hockey "Puck Line"/"Total Goals". Guessing one family's names from
 * another's is how an MLB lookup comes back empty with nothing to say why.
 */
const GAME_MARKETS: Record<string, { spread: string; total: string }> = {
  football: { spread: "Point Spread", total: "Total Points" },
  basketball: { spread: "Point Spread", total: "Total Points" },
  baseball: { spread: "Run Line", total: "Total Runs" },
  hockey: { spread: "Puck Line", total: "Total Goals" },
};

/** Team totals are carried, under one name in every sport ("Team Total", "1st Half Team Total"). */
const TEAM_TOTAL = "Team Total";

/**
 * Board spellings that normalization alone cannot reconcile with the feed's own name.
 *
 * Kept deliberately small, and it is the *last* thing consulted: `resolveClosingMarket` already
 * turns a board's spelling into this project's canonical "Player X" name, and the feed's names are
 * that same vocabulary. A table of market names is the thing that rots, so anything normalization
 * or the canonical map can handle must be handled there instead.
 */
const MARKET_ALIASES: Record<string, string> = {
  // A DFS board writes total bases as bare "Bases"; the feed says "Player Bases".
  bases: "bases",
  "total bases": "bases",
  sog: "shots on goal",
  "blks plus stls": "blocks plus steals",
  "3 pointers made": "three pointers made",
  "threes made": "three pointers made",
  "made threes": "three pointers made",
};

/**
 * Every market name, in comparable form, that counts as an answer for one pick.
 *
 * Returned as a set of keys rather than a single name because a board and this feed can legitimately
 * disagree about spelling in three independent ways, and a lookup should survive all of them:
 *
 *  - the "Player " prefix, which `marketFilterKey` already strips from both sides;
 *  - the whole word ("Bases" vs "Player Bases", "SOG" vs "Player Shots On Goal"), which the
 *    canonical map and then `MARKET_ALIASES` cover;
 *  - a period qualifier, which this feed writes as a *prefix* ("1st Half Player Touchdowns") where
 *    PropProfessor's vocabulary writes it as a suffix ("Player Touchdowns - 1st Half").
 *
 * Fails closed in the one way that matters: a period-qualified pick only ever matches a
 * period-qualified name, so "1st Half Player Touchdowns" can never be answered with the full-game
 * market, which would be a wrong answer that parses perfectly.
 */
export function oddsTerminalMarketKeys(
  sport: string | null,
  marketType: MarketType,
  statMarket: string | null
): string[] {
  const keys = new Set<string>();
  const add = (name: string | null | undefined) => {
    const key = marketFilterKey(name);
    if (key) keys.add(MARKET_ALIASES[key] ?? key);
  };

  const raw = normalizeMarketName(statMarket);
  const { base, period } = extractPeriod(raw);
  const family = ODDS_TERMINAL_SPORTS[propProfessorLeague(sport) ?? ""]?.sport ?? "";
  const withPeriod = (name: string) => (period ? `${period} ${name}` : name);

  if (marketType === "MONEYLINE") {
    add(withPeriod("Moneyline"));
    return [...keys];
  }
  if (marketType === "SPREAD") {
    const spread = GAME_MARKETS[family]?.spread;
    if (spread) add(withPeriod(spread));
    return [...keys];
  }
  if (marketType === "GAME_TOTAL") {
    if (/\bteam\b/.test(base)) {
      add(withPeriod(TEAM_TOTAL));
      return [...keys];
    }
    const total = GAME_MARKETS[family]?.total;
    if (total) add(withPeriod(total));
    // A board that named the total specifically ("Total Touchdowns", "Total Hits") is taken at its
    // word as well -- the feed carries those alongside the league's own headline total.
    add(statMarket);
    return [...keys];
  }

  // A player prop. Three spellings: the board's own, this project's canonical name for it, and the
  // canonical name with the period moved to the front.
  add(statMarket);
  const resolved = resolveClosingMarket(sport, statMarket, marketType);
  if (resolved.ok) {
    // `resolveClosingMarket` returns "Player Touchdowns - 1st Half"; this feed spells that
    // "1st Half Player Touchdowns".
    const [canonical, suffix] = resolved.market.split(" - ");
    add(suffix ? `${suffix} ${canonical}` : canonical);
  }
  return [...keys];
}

/** The comparable form of a market name as it came off the wire. */
export function oddsTerminalMarketKey(name: string | null | undefined): string {
  const key = marketFilterKey(name);
  return MARKET_ALIASES[key] ?? key;
}

// --- read planning ----------------------------------------------------------------------------

export interface OddsTerminalReadPlan {
  /** The `sport` query value. */
  sport: string;
  /** The league id: a query filter, and what a returned fixture must carry to be this pick's. */
  league: string;
  /** Every market name, in comparable form, that answers this pick. Never empty. */
  marketKeys: string[];
  /** The books to ask for, as ids, five per request. */
  bookChunks: string[][];
  /** The user's own book ranking, kept so a caller can re-derive the order. */
  bookOrder: string[];
  marketType: MarketType;
  /** The market name as the *pick* spells it, carried through so the shared matcher still works. */
  requestedStatMarket: string;
  /**
   * The pick's own kickoff, when the board recorded one.
   *
   * Not a filter on the odds -- it narrows the *slate* request to a few hours either side, which
   * turns a 121-fixture two-page college slate into a handful of games and removes most of the
   * chances for two fixtures to look like one matchup.
   */
  gameStartIso: string | null;
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
  pick: {
    sport: string | null;
    statMarket: string | null;
    marketType: MarketType;
    gameStartIso?: string | null;
  },
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

  const marketKeys = oddsTerminalMarketKeys(pick.sport, pick.marketType, pick.statMarket);
  if (marketKeys.length === 0) {
    return {
      kind: "noEquivalent",
      reason: `Odds Terminal has no ${league} equivalent of "${pick.statMarket}".`,
    };
  }

  return {
    sport: sport.sport,
    league: sport.league,
    marketKeys,
    bookChunks: oddsTerminalBookChunks(options.bookOrder ?? []),
    bookOrder: options.bookOrder ?? [],
    marketType: pick.marketType,
    requestedStatMarket: pick.statMarket ?? "",
    gameStartIso: pick.gameStartIso ?? null,
  };
}

/** Shared query shape. Relative path only -- see this module's header. */
function snapshotPath(params: URLSearchParams, books: string[]): string {
  for (const book of books) params.append("sportsbook", book);
  return `/api/snapshot?${params.toString()}`;
}

/**
 * The slate request: which games this league has, over the window the pick needs.
 *
 * `start_date_after`/`start_date_before` are the site's own "Next 7 days" control, and without them
 * the endpoint answers for the next 36 hours only -- which on a Wednesday is an NFL slate of one
 * Thursday game, and no Sunday at all. When the board recorded the pick's kickoff the window is
 * narrowed to half a day either side of it instead, which is both cheaper and less ambiguous.
 */
export function oddsTerminalFixturesPath(
  plan: OddsTerminalReadPlan,
  options: { page?: number; now?: Date } = {}
): string {
  const now = options.now ?? new Date();
  const start = plan.gameStartIso ? new Date(plan.gameStartIso) : null;
  const usable = start && Number.isFinite(start.getTime()) ? start : null;

  const after = usable
    ? new Date(usable.getTime() - 12 * 60 * 60 * 1000)
    : new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const before = usable
    ? new Date(usable.getTime() + 12 * 60 * 60 * 1000)
    : new Date(now.getTime() + ODDS_TERMINAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    sport: plan.sport,
    league: plan.league,
    // "all" is the games filter, not the market scope: the endpoint takes all/live/upcoming and
    // answers `400 Invalid game filter.` to anything else. A pick can be on a game that has already
    // started (a live board), so "upcoming" would be wrong.
    mode: "all",
    page: String(options.page ?? 1),
    start_date_after: after.toISOString(),
    start_date_before: before.toISOString(),
  });
  // One book is enough to list a slate -- fixtures come back whether or not that book prices them,
  // and the odds this request carries are thrown away. Asking for five would multiply the response
  // (419 KB against 56 KB on one NFL slate) for nothing.
  return snapshotPath(params, plan.bookChunks[0]?.slice(0, 1) ?? []);
}

/**
 * The odds request: every market one fixture has, for one chunk of books.
 *
 * This is the request the whole source turns on. With `fixture_id` the endpoint stops summarising
 * the slate and returns the fixture's entire book -- player props, alternates, period markets, the
 * lot. Without it, props are simply absent, which is what the previous implementation ran into.
 */
export function oddsTerminalOddsPath(
  plan: OddsTerminalReadPlan,
  fixtureId: string,
  books: string[] = plan.bookChunks[0] ?? []
): string {
  const params = new URLSearchParams({
    sport: plan.sport,
    league: plan.league,
    mode: "all",
    page: "1",
    fixture_id: fixtureId,
  });
  return snapshotPath(params, books);
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

/** Splits "Boston College vs. Rutgers" / "Rutgers @ Boston College" into its normalized sides. */
function matchupSides(matchup: string | null): string[] {
  if (!matchup) return [];
  return matchup
    .split(/\s+(?:vs\.?|v\.?|@|at)\s+/i)
    .map((s) => normalizeName(s))
    .filter(Boolean);
}

/** True when a normalized board team name and a feed team name are plausibly the same club. */
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
 * assumed to be the right one. One `sport=football` response can hold NFL, NCAAF and CFL games
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
 * and **ambiguity is a refusal rather than a coin toss** -- except where the pick's own kickoff
 * time settles it, which is a fact about this game rather than a guess between two.
 *
 * Returning the wrong fixture is far worse than returning none: the market would then parse
 * perfectly and describe a different game.
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

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;

  // Two fixtures answering to one matchup is normally a refusal. A kickoff time the board recorded
  // is the one thing that can separate them honestly -- a doubleheader, or the same two teams
  // meeting again inside the window -- so the nearest start wins, and only if it is clearly nearer.
  const wanted = plan.gameStartIso ? new Date(plan.gameStartIso).getTime() : NaN;
  if (!Number.isFinite(wanted)) return null;

  const scored = candidates
    .map((fixture) => {
      const start = str(fixture.start_date);
      const at = start ? new Date(start).getTime() : NaN;
      return { fixture, gap: Number.isFinite(at) ? Math.abs(at - wanted) : Number.POSITIVE_INFINITY };
    })
    .sort((a, b) => a.gap - b.gap);

  const [best, runnerUp] = scored;
  const HOUR = 60 * 60 * 1000;
  return best.gap <= 6 * HOUR && runnerUp.gap - best.gap > 3 * HOUR ? best.fixture : null;
}

/**
 * The snapshot response, as far as this module cares about it.
 *
 * `fixtures` and `odds` are siblings: odds are a flat array keyed by `fixture_id`, never nested
 * under their fixture. `totalPages`/`hasMore` are what a slate read has to follow -- a 7-day NCAAF
 * slate is two pages, and a reader that stops at the first one cannot see a fifth of the games.
 */
export interface OddsTerminalSnapshot {
  fixtures?: unknown;
  odds?: unknown;
  page?: unknown;
  totalPages?: unknown;
  hasMore?: unknown;
}

/** The fixtures a snapshot body carried, or an empty list when it carried none. */
export function oddsTerminalFixturesOf(body: unknown): OddsTerminalFixture[] {
  if (!body || typeof body !== "object") return [];
  const fixtures = (body as OddsTerminalSnapshot).fixtures;
  return Array.isArray(fixtures) ? (fixtures as OddsTerminalFixture[]) : [];
}

/** Whether a slate response says there is another page, and what it is. */
export function oddsTerminalNextPage(body: unknown, page: number): number | null {
  if (!body || typeof body !== "object") return null;
  const snapshot = body as OddsTerminalSnapshot;
  const total = typeof snapshot.totalPages === "number" ? snapshot.totalPages : 1;
  const more = snapshot.hasMore === true || page < total;
  return more && page < ODDS_TERMINAL_MAX_FIXTURE_PAGES ? page + 1 : null;
}
