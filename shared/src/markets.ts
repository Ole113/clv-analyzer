/**
 * Translating a captured pick's market into the name a closing source will answer to.
 *
 * This layer did not exist before because the optimizer read never needed it: the board was already
 * open on the market in question, so whatever label it rendered was matched loosely by
 * `findMatchingRow`'s substring scoring. An odds screen inverts that -- the market name has to be
 * known *before* the request is sent, exactly, or nothing comes back at all.
 *
 * The live database already carries "Rushing Yards", "Receiving Yards" AND "Player Receiving Yards"
 * for what are only two concepts, because different boards spell them differently. PropProfessor
 * wants a third spelling again.
 *
 * Names verified against PropProfessor's own market dropdown, extracted from its page bundle
 * (see __fixtures__/pp-screen-vocabulary.json). Their `value` is what the API accepts; the `label`
 * shown in the dropdown is sometimes different ("Player Pass + Rush + Rec Touchdowns" is sent as
 * "Player Passing + Rushing + Receiving Touchdowns"), so this table holds values, never labels.
 */

import type { MarketType } from "./types";

/** Lowercased, punctuation-free, so "Break Points Won" and "breakpoints won" collapse together. */
export function normalizeMarketName(input: string | null | undefined): string {
  return (input ?? "")
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The identity two boards' spellings of one market collapse onto, for the hide-markets filter.
 *
 * Deliberately *not* `PROPPROFESSOR_MARKETS`. That table exists to name a market to an odds screen
 * exactly, so it only knows the markets a sportsbook prices -- which is the opposite of what a hide
 * list is for. The markets most worth hiding (DFS-only "Fantasy Score", period-qualified
 * "Receiving Yards - 1st Half", "Longest Reception") are precisely the ones that table has no entry
 * for, so routing through it would leave the filter unable to name the things it exists to remove.
 *
 * The rule instead is structural: normalize, then drop a leading "Player ", which is the one prefix
 * the two boards genuinely disagree about ("Receiving Yards" on OddsJam, "Player Receiving Yards"
 * on PropProfessor). "Pitcher " is deliberately NOT dropped -- a pitcher's strikeouts and a
 * batter's are different markets, and collapsing them would hide one when the user asked to hide
 * the other.
 */
export function marketFilterKey(name: string | null | undefined): string {
  const normalized = normalizeMarketName(name);
  return normalized.startsWith("player ") ? normalized.slice("player ".length) : normalized;
}

/**
 * Captured market name -> this project's canonical market name.
 *
 * Keyed by `normalizeMarketName` output. Both the bare and the "player"-prefixed spellings are
 * listed for each concept because the two boards genuinely disagree and both reach the database.
 *
 * The name is historical: these values were transcribed from PropProfessor's own market dropdown,
 * and nothing reads that site any more (see `oddsjam-automation-guard.test.ts`). The table stays
 * because the vocabulary outlived the source that supplied it -- Odds Terminal spells its markets
 * the same way, so `oddsTerminalMarketKeys` resolves a board's spelling through here to get the
 * name that feed will answer to. It is a table of words; it is not a read target.
 */
export const PROPPROFESSOR_MARKETS: Record<string, string> = {
  // --- football ---
  "rushing yards": "Player Rushing Yards",
  "player rushing yards": "Player Rushing Yards",
  "rushing attempts": "Player Rushing Attempts",
  "player rushing attempts": "Player Rushing Attempts",
  "rushing touchdowns": "Player Rushing Touchdowns",
  "player rushing touchdowns": "Player Rushing Touchdowns",
  "receiving yards": "Player Receiving Yards",
  "player receiving yards": "Player Receiving Yards",
  "receptions": "Player Receptions",
  "player receptions": "Player Receptions",
  "receiving targets": "Player Receiving Targets",
  "player receiving targets": "Player Receiving Targets",
  "receiving touchdowns": "Player Receiving Touchdowns",
  "player receiving touchdowns": "Player Receiving Touchdowns",
  "passing yards": "Player Passing Yards",
  "player passing yards": "Player Passing Yards",
  "passing touchdowns": "Player Passing Touchdowns",
  "player passing touchdowns": "Player Passing Touchdowns",
  "passing attempts": "Player Passing Attempts",
  "player passing attempts": "Player Passing Attempts",
  "passing completions": "Player Passing Completions",
  "player passing completions": "Player Passing Completions",
  "interceptions": "Player Interceptions",
  "player interceptions": "Player Interceptions",
  "rushing plus receiving yards": "Player Rushing + Receiving Yards",
  "player rushing plus receiving yards": "Player Rushing + Receiving Yards",
  "passing plus rushing yards": "Player Passing + Rushing Yards",
  "player passing plus rushing yards": "Player Passing + Rushing Yards",
  "tackles plus assists": "Player Tackles + Assists",
  "player tackles plus assists": "Player Tackles + Assists",
  // Confirmed in the captured vocabulary alongside "Tackles + Assists" above (see the fixture
  // comment in stat-map.ts's MARKETS table for why "Tackles" and "Tackles + Assists" are treated
  // as the same underlying stat for grading, despite being separate dropdown entries here).
  tackles: "Player Tackles",
  "player tackles": "Player Tackles",
  "solo tackles": "Player Solo Tackles",
  "player solo tackles": "Player Solo Tackles",
  "tackles assisted": "Player Tackles Assisted",
  "player tackles assisted": "Player Tackles Assisted",
  "tackles for loss": "Player Tackles For Loss",
  "player tackles for loss": "Player Tackles For Loss",
  sacks: "Player Sacks",
  "player sacks": "Player Sacks",
  "kicking points": "Player Kicking Points",
  "player kicking points": "Player Kicking Points",
  // Longest-X, touchdown and kicking markets: all carried by the screen, none previously aliased,
  // and between them the bulk of the "no PropProfessor market alias" reports.
  "longest reception": "Player Longest Reception",
  "longest rush": "Player Longest Rush",
  "longest completion": "Player Longest Completion",
  "longest field goal made": "Player Longest Field Goal Made",
  touchdowns: "Player Touchdowns",
  "field goals made": "Player Field Goals Made",
  "pat made": "Player PAT Made",
  "extra points made": "Player PAT Made",
  "first downs": "Player First Downs",
  fumbles: "Player Fumbles",
  "fumbles lost": "Player Fumbles Lost",
  "times sacked": "Player Times Sacked",
  "passing plus receiving yards": "Player Passing + Receiving Yards",
  "passing plus rushing plus receiving touchdowns": "Player Passing + Rushing + Receiving Touchdowns",
  "pass plus rush plus rec touchdowns": "Player Passing + Rushing + Receiving Touchdowns",

  // --- basketball ---
  points: "Player Points",
  "player points": "Player Points",
  rebounds: "Player Rebounds",
  "player rebounds": "Player Rebounds",
  assists: "Player Assists",
  "player assists": "Player Assists",
  "points plus rebounds plus assists": "Player Points + Rebounds + Assists",
  "pts plus reb plus ast": "Player Points + Rebounds + Assists",
  // The screen's value is "Player Threes Made" -- not "Player Three Pointers Made", which is what
  // this mapped to until a sweep against __fixtures__/pp-screen-vocabulary.json caught it. Every
  // three-point pick was asking the screen for a market it does not carry.
  "three pointers made": "Player Threes Made",
  "3 pointers made": "Player Threes Made",
  "threes made": "Player Threes Made",
  "made threes": "Player Threes Made",
  "three pointers attempted": "Player Threes Attempted",
  "threes attempted": "Player Threes Attempted",
  "points plus assists": "Player Points + Assists",
  "points plus rebounds": "Player Points + Rebounds",
  "rebounds plus assists": "Player Rebounds + Assists",
  "blocks plus steals": "Player Blocks + Steals",
  "blks plus stls": "Player Blocks + Steals",
  steals: "Player Steals",
  turnovers: "Player Turnovers",
  "free throws made": "Player Free Throws Made",
  "field goals attempted": "Player Field Goals Attempted",
  "minutes played": "Player Minutes Played",
  "double double": "Player Double Double",
  "triple double": "Player Triple Double",

  // --- tennis ---
  aces: "Player Aces",
  "player aces": "Player Aces",
  // PropProfessor spells this as one word; OddsJam uses two. This exact pair is why the table
  // cannot be a simple "Player " prefix rule.
  "break points won": "Player Breakpoints Won",
  "breakpoints won": "Player Breakpoints Won",
  "player breakpoints won": "Player Breakpoints Won",
  "aces plus double faults": "Player Aces + Double Faults",
  "double faults": "Player Double Faults",
  "games won": "Player Games Won",
  "sets won": "Player Sets Won",

  // --- UFC ---
  // "Sig Strikes" is the spelling the DFS boards use; the screen wants it written out.
  "significant strikes": "Player Significant Strikes",
  "sig strikes": "Player Significant Strikes",
  takedowns: "Player Takedowns",
  strikes: "Player Strikes",

  // --- baseball ---
  strikeouts: "Player Strikeouts",
  "player strikeouts": "Player Strikeouts",
  hits: "Player Hits",
  "player hits": "Player Hits",
  "total bases": "Player Total Bases",
  "player total bases": "Player Total Bases",
  // DFS-app shorthand for the same market.
  bases: "Player Total Bases",
  "player bases": "Player Total Bases",
  runs: "Player Runs",
  "player runs": "Player Runs",
  rbis: "Player RBIs",
  "player rbis": "Player RBIs",
  "hits plus runs plus rbis": "Player Hits + Runs + RBIs",
  "player hits plus runs plus rbis": "Player Hits + Runs + RBIs",
  "runs plus rbis": "Player Runs + RBIs",
  "player runs plus rbis": "Player Runs + RBIs",
  singles: "Player Singles",
  "player singles": "Player Singles",
  doubles: "Player Doubles",
  "player doubles": "Player Doubles",
  triples: "Player Triples",
  "player triples": "Player Triples",
  "home runs": "Player Home Runs",
  "player home runs": "Player Home Runs",
  walks: "Player Walks",
  "player walks": "Player Walks",
  "stolen bases": "Player Stolen Bases",
  "player stolen bases": "Player Stolen Bases",
  // Bare "strikeouts" above is the batter's own; a pitcher's is only ever captured with the
  // "pitcher" prefix, so it needs no bare entry of its own.
  "pitcher strikeouts": "Pitcher Strikeouts",
  "earned runs allowed": "Pitcher Earned Runs Allowed",
  "pitcher earned runs allowed": "Pitcher Earned Runs Allowed",
  "runs allowed": "Pitcher Runs Allowed",
  "pitcher runs allowed": "Pitcher Runs Allowed",
  "hits allowed": "Pitcher Hits Allowed",
  "pitcher hits allowed": "Pitcher Hits Allowed",
  "home runs allowed": "Pitcher Home Runs Allowed",
  "pitcher home runs allowed": "Pitcher Home Runs Allowed",
  "walks allowed": "Pitcher Walks Allowed",
  "pitcher walks allowed": "Pitcher Walks Allowed",
  "outs recorded": "Pitcher Outs Recorded",
  "pitcher outs recorded": "Pitcher Outs Recorded",
  // DFS-app shorthand for the same market.
  outs: "Pitcher Outs Recorded",
  "pitcher outs": "Pitcher Outs Recorded",
  "pitches thrown": "Pitcher Pitches Thrown",
  "pitcher pitches thrown": "Pitcher Pitches Thrown",

  // --- hockey ---
  "shots on goal": "Player Shots On Goal",
  "player shots on goal": "Player Shots On Goal",
  saves: "Player Saves",
  "player saves": "Player Saves",
  goals: "Player Goals",
  "player goals": "Player Goals",
  // Assists/Points/Hits are already aliased above (basketball/baseball) to the same target string
  // PropProfessor uses for the hockey market of the same name -- the request's separate `league`
  // field is what disambiguates the sport, not this table, so one shared entry already covers both.
  blocks: "Player Blocks",
  "player blocks": "Player Blocks",
  "blocked shots": "Player Blocked Shots",
  "player blocked shots": "Player Blocked Shots",
  "faceoffs won": "Player Faceoffs Won",
  "player faceoffs won": "Player Faceoffs Won",
  "plus minus": "Player Plus/Minus",
  "player plus minus": "Player Plus/Minus",
  "goals allowed": "Player Goals Allowed",
  "player goals allowed": "Player Goals Allowed",
  "goals plus assists": "Player Goals + Assists",
  "time on ice": "Player Time On Ice",
  "power play points": "Player Power Play Points",
  shots: "Player Shots",

  /* --- carried by the screen but not seen on a board yet ------------------
     Filled in from a sweep of __fixtures__/pp-screen-vocabulary.json rather than waiting for each
     one to fail live. Nothing here is a guess: every value is a market the screen answers to, and
     the key is its `marketFilterKey`, so both the bare and the "Player "-prefixed spelling resolve
     through MARKETS_BY_FILTER_KEY. Mostly out-of-season sports -- basketball, soccer and golf are
     where the next round of "unknown alias" reports would otherwise have come from. */
  // football
  "completion percentage": "Player Completion Percentage",
  "passing first downs": "Player Passing First Downs",
  punts: "Player Punts",
  // basketball
  "defensive rebounds": "Player Defensive Rebounds",
  "offensive rebounds": "Player Offensive Rebounds",
  dunks: "Player Dunks",
  "field goals missed": "Player Field Goals Missed",
  fouls: "Player Fouls",
  "personal fouls": "Player Personal Fouls",
  "free throws attempted": "Player Free Throws Attempted",
  "turnovers plus steals": "Player Turnovers + Steals",
  "turnovers plus steals plus blocks": "Player Turnovers + Steals + Blocks",
  "twos made": "Player Twos Made",
  "twos attempted": "Player Twos Attempted",
  // hockey
  shutout: "Player Shutout",
  // soccer -- "fouls" is shared with basketball above and maps to the same screen market
  cards: "Player Cards",
  clearances: "Player Clearances",
  crosses: "Player Crosses",
  "dribbles attempted": "Player Dribbles Attempted",
  "fouls committed": "Player Fouls Committed",
  "fouls drawn": "Player Fouls Drawn",
  offsides: "Player Offsides",
  passes: "Player Passes",
  "shots assisted": "Player Shots Assisted",
  // UFC
  knockouts: "Player Knockouts",
  submissions: "Player Submissions",
  // golf
  birdies: "Player Birdies",
  "birdies or better": "Player Birdies Or Better",
  bogeys: "Player Bogeys",
  "bogeys or worse": "Player Bogeys Or Worse",
  eagles: "Player Eagles",
  "fairways hit": "Player Fairways Hit",
  "greens in regulation": "Player Greens In Regulation",
  pars: "Player Pars",
  strokes: "Player Strokes",
  "to make the cut": "Player To Make The Cut",

  // --- game markets ---
  moneyline: "Moneyline",
  "money line": "Moneyline",
  spread: "Point Spread",
  "point spread": "Point Spread",
  // Named totals, so a board that said which total it meant is not flattened into the league's
  // default by the GAME_TOTAL branch of resolveClosingMarket.
  "total points": "Total Points",
  "total runs": "Total Runs",
  "total goals": "Total Goals",
  "total games": "Total Games",
  "total sets": "Total Sets",
  "total rounds": "Total Rounds",
  "total touchdowns": "Total Touchdowns",
  "total field goals": "Total Field Goals",
  "total hits": "Total Hits",
  "total home runs": "Total Home Runs",
  "total shots on goal": "Total Shots On Goal",
  "total corners": "Total Corners",
  "total cards": "Total Cards",
  "total tie breaks": "Total Tie Breaks",
  "total first downs": "Total First Downs",
  "total sacks": "Total Sacks",
  "total turnovers": "Total Turnovers",
  "total punts": "Total Punts",
  "total offsides": "Total Offsides",
  "total receiving yards": "Total Receiving Yards",
  "total rushing yards": "Total Rushing Yards",
  "total rushing touchdowns": "Total Rushing Touchdowns",
  "total shots": "Total Shots",
  "total shots on target": "Total Shots On Target",
  "total tackles": "Total Tackles",
  // Named team totals, same reasoning as the game totals above: a board that said which team total
  // it meant is not flattened into the league's default by the team-total branch of
  // resolveClosingMarket.
  "team total points": "Team Total Points",
  "team total touchdowns": "Team Total Touchdowns",
  "team total field goals": "Team Total Field Goals",
  "team total yards": "Team Total Yards",
  "team total rushing yards": "Team Total Rushing Yards",
  "team total rushing touchdowns": "Team Total Rushing Touchdowns",
  "team total passing yards": "Team Total Passing Yards",
  "team total passing touchdowns": "Team Total Passing Touchdowns",
  "team total receptions": "Team Total Receptions",
  "team total sacks": "Team Total Sacks",
  "team total runs": "Team Total Runs",
  "team total goals": "Team Total Goals",
  "team total shots on goal": "Team Total Shots On Goal",
  "team total corners": "Team Total Corners",
  "team total cards": "Team Total Cards",
  "team total shots": "Team Total Shots",
  "team total shots on target": "Team Total Shots On Target",
  "team total offsides": "Team Total Offsides",
  "team total tackles": "Team Total Tackles",
};

/**
 * Markets no sportsbook prices, so no closing line can ever exist for them.
 *
 * These are not failures and must never burn retries: a PrizePicks "Fantasy Score" is a scoring
 * formula proprietary to that app. Period-qualified props ("1st Quarter Passing Yards") used to be
 * listed here too, on the assumption the screen carries full-game markets only -- it doesn't: PP's
 * own "Game" dropdown breaks almost every market down by quarter/half/inning/period, see
 * `extractPeriod` below. Seeded from the prose already in the grading stat-map, which reached the
 * same conclusions for the same reasons.
 */
export const NO_SPORTSBOOK_EQUIVALENT: RegExp[] = [
  /\bfantasy (score|points)\b/,
  /\bdfs\b/,
  /\bpick\s?em\b/,
  // Unlike the innings-count markets `extractPeriod` handles below, a first-N-minutes market has
  // never been confirmed on the screen's "Game" dropdown -- left unsupported rather than guessed at.
  /\bfirst\s+\d+\s+minutes\b/,
];

/** Ordinal word or numeral, normalized to the spelling PropProfessor's own dropdown uses. */
const PERIOD_ORDINALS: Record<string, string> = {
  "1st": "1st",
  first: "1st",
  "2nd": "2nd",
  second: "2nd",
  "3rd": "3rd",
  third: "3rd",
  "4th": "4th",
  fourth: "4th",
};

/** Period unit word, normalized to PropProfessor's own title-cased spelling. */
const PERIOD_UNITS: Record<string, string> = {
  quarter: "Quarter",
  qtr: "Quarter",
  half: "Half",
  period: "Period",
  inning: "Inning",
  set: "Set",
};

/** "Q1"/"H1"/"P1" shorthand, normalized straight to the canonical label a written-out period gets. */
const SHORT_PERIOD_LABELS: Record<string, string> = {
  q1: "1st Quarter",
  q2: "2nd Quarter",
  q3: "3rd Quarter",
  q4: "4th Quarter",
  h1: "1st Half",
  h2: "2nd Half",
  p1: "1st Period",
  p2: "2nd Period",
  p3: "3rd Period",
};

const LONG_PERIOD_RE = /\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+(quarter|qtr|half|period|inning|set)\b/;
const SHORT_PERIOD_RE = /\b(q[1-4]|h[1-2]|p[1-3])\b/;
/** MLB's own dropdown offers these as a distinct concept from a single inning -- "1st 5 Innings" is
 *  its own market, not "1st Inning" with a typo -- so it gets its own pattern and its own label. */
const CUMULATIVE_INNINGS_RE = /\bfirst\s+(\d+)\s+innings\b/;

/**
 * Splits a period qualifier off a normalized market name and translates it to the exact label
 * PropProfessor's own "Game" dropdown uses, confirmed against the live site: selecting a market and
 * a period there sends a WebSocket `subscribe` whose `market` field is `"<market> - <period>"` verbatim
 * (e.g. "Team Total Points - 1st Quarter", "Total Points - 1st Half", "Team Total Runs - 1st Inning").
 * Nothing about period support lives in a separate request field -- it is entirely this suffix.
 *
 * Returns the market name with the qualifier removed either way, and a null period when none is
 * found, so a plain full-game market passes through unchanged.
 */
export function extractPeriod(stat: string): { base: string; period: string | null } {
  const strip = (match: string) => stat.replace(match, " ").replace(/\s+/g, " ").trim();

  const cumulative = stat.match(CUMULATIVE_INNINGS_RE);
  if (cumulative) return { base: strip(cumulative[0]), period: `1st ${cumulative[1]} Innings` };

  const long = stat.match(LONG_PERIOD_RE);
  if (long) return { base: strip(long[0]), period: `${PERIOD_ORDINALS[long[1]]} ${PERIOD_UNITS[long[2]]}` };

  const short = stat.match(SHORT_PERIOD_RE);
  if (short) return { base: strip(short[0]), period: SHORT_PERIOD_LABELS[short[1]] };

  return { base: stat, period: null };
}

/** League slug PropProfessor's screen expects, from whatever the capture called the sport. */
export const PROPPROFESSOR_LEAGUES: Record<string, string> = {
  nfl: "NFL",
  ncaaf: "NCAAF",
  "college football": "NCAAF",
  cfb: "NCAAF",
  nba: "NBA",
  ncaab: "NCAAB",
  "college basketball": "NCAAB",
  cbb: "NCAAB",
  wnba: "WNBA",
  nhl: "NHL",
  mlb: "MLB",
  npb: "NPB",
  kbo: "KBO",
  cfl: "CFL",
  pga: "PGA",
  golf: "PGA",
  ufc: "UFC",
  mma: "UFC",
  soccer: "Soccer",
  football: "Soccer", // only reachable when the capture said "football" meaning association football
  // PropProfessor has no ATP/WTA split -- both tours are one "Tennis" league.
  atp: "Tennis",
  wta: "Tennis",
  tennis: "Tennis",
  csgo: "CSGO",
  cs2: "CSGO",
  cod: "COD",
  lol: "LoL",
  valorant: "Valorant",
};

/**
 * Soccer competitions, which the boards name instead of naming the sport.
 *
 * OddsJam's game boards write the competition and the country -- "Germany - Bundesliga",
 * "Portugal - Primeira Liga", "Brazil - Serie A" -- where every other sport gets a league code, so
 * none of them can be listed in `PROPPROFESSOR_LEAGUES` above without enumerating every country and
 * division in the world. PropProfessor has exactly one "Soccer" league covering all of them, so
 * recognising the competition is enough to name the league.
 *
 * Matched as words inside the normalized sport rather than as whole values, which is what lets one
 * entry cover "Germany - Bundesliga" and "Austria - Bundesliga" alike. Deliberately a list of
 * competitions and not a "<country> - <anything>" rule: OddsJam spells basketball and baseball
 * competitions the same way ("Germany - BBL", "Japan - NPB"), and a structural rule would quietly
 * file those under Soccer.
 */
const SOCCER_COMPETITIONS = [
  "bundesliga",
  "primeira liga",
  "serie a",
  "la liga",
  "laliga",
  "premier league",
  "ligue 1",
  "eredivisie",
  "mls",
  "major league soccer",
  "champions league",
  "europa league",
  "conference league",
  "liga mx",
  "brasileirao",
  "super lig",
  "allsvenskan",
  "eliteserien",
  "copa",
  "efl",
  "world cup",
  "euro qualifiers",
  "nations league",
];

/**
 * The league a board's sport column resolves to, competition names included.
 *
 * Exported because it is the project's one canonical "what sport is this pick" resolver, and The
 * Odds API adapter needs the same answer: it maps this league code onto its own sport key rather
 * than re-reading the board's raw sport text, so a spelling the boards use ("Japan - NPB",
 * "Germany - Bundesliga") is understood identically by both sources. The name keeps its
 * PropProfessor prefix because these are PropProfessor's league spellings -- they are simply also
 * the internal vocabulary everything else keys off.
 */
export function propProfessorLeague(sport: string | null): string | null {
  const normalized = normalizeMarketName(sport);
  if (!normalized) return null;
  const direct = PROPPROFESSOR_LEAGUES[normalized];
  if (direct) return direct;

  // "Japan - NPB", "USA - NBA": the same country-first spelling as the soccer competitions, on a
  // sport whose league PropProfessor does name. Only the part after the qualifier is retried, and
  // only against the table above -- an unrecognised tail stays unmapped rather than being guessed
  // at, so a genuine gap is still loud.
  const tail = (sport ?? "").split(/\s[-\u2013]\s/).pop();
  const qualified = tail ? PROPPROFESSOR_LEAGUES[normalizeMarketName(tail)] : undefined;
  if (qualified) return qualified;

  // Word-bounded so "serie a" does not also claim a hypothetical "serie ateam", and so a
  // competition sitting at either end of the string still matches.
  return SOCCER_COMPETITIONS.some((competition) =>
    new RegExp(`(^| )${competition}( |$)`).test(normalized)
  )
    ? "Soccer"
    : null;
}

/**
 * What "the total" is called, per league.
 *
 * A game total is the one market whose screen name is decided by the sport rather than by anything
 * the board wrote: the same `GAME_TOTAL` pick is "Total Points" in football and basketball, "Total
 * Runs" in baseball, "Total Goals" in hockey and soccer, "Total Games" in tennis and "Total Rounds"
 * in UFC. `resolveClosingMarket` used to special-case only MONEYLINE and SPREAD, so every game
 * total fell through to the player-prop table and came back unmapped -- which is the whole of the
 * reported "no PropProfessor market alias for \"Total Points\" / \"Total Games\"" failures.
 */
export const PROPPROFESSOR_GAME_TOTALS: Record<string, string> = {
  NFL: "Total Points",
  NCAAF: "Total Points",
  CFL: "Total Points",
  NBA: "Total Points",
  NCAAB: "Total Points",
  WNBA: "Total Points",
  MLB: "Total Runs",
  NPB: "Total Runs",
  KBO: "Total Runs",
  NHL: "Total Goals",
  Soccer: "Total Goals",
  Tennis: "Total Games",
  UFC: "Total Rounds",
};

/**
 * What "the team total" is called, per league -- the same idea as `PROPPROFESSOR_GAME_TOTALS`, one
 * level down. A team total is keyed by which team, not by a number of its own, so its screen name is
 * decided by the sport the same way a game total's is: "Team Total Points" in football and
 * basketball, "Team Total Runs" in baseball, "Team Total Goals" in hockey and soccer. Tennis and UFC
 * have no team-total concept and are left out on purpose.
 */
export const PROPPROFESSOR_TEAM_TOTALS: Record<string, string> = {
  NFL: "Team Total Points",
  NCAAF: "Team Total Points",
  CFL: "Team Total Points",
  NBA: "Team Total Points",
  NCAAB: "Team Total Points",
  WNBA: "Team Total Points",
  MLB: "Team Total Runs",
  NPB: "Team Total Runs",
  KBO: "Team Total Runs",
  NHL: "Team Total Goals",
  Soccer: "Team Total Goals",
};

/**
 * The same table again, keyed by `marketFilterKey` so a "Player "-prefixed spelling finds an entry
 * stored bare, and vice versa.
 *
 * Every board spells roughly half its markets with the prefix and half without, and keeping two
 * hand-written rows per concept is what let "Player Points + Rebounds + Assists" come back unmapped
 * while "Points + Rebounds + Assists" resolved fine. Derived rather than duplicated, so a market
 * added in one spelling is reachable in both. First declaration wins, which only matters for keys
 * that would otherwise collide -- and "Pitcher " is deliberately left on by `marketFilterKey`, so
 * a pitcher's strikeouts never collapse onto a batter's.
 */
const MARKETS_BY_FILTER_KEY: Record<string, string> = (() => {
  const index: Record<string, string> = {};
  for (const [alias, market] of Object.entries(PROPPROFESSOR_MARKETS)) {
    const key = marketFilterKey(alias);
    if (key && !(key in index)) index[key] = market;
  }
  return index;
})();

/**
 * A total's name with the framing words stripped, leaving only the stat it claims to count:
 * "1st Inning Team Total Pitches Thrown" -> "pitches thrown", "Game Total" -> "", "Total" -> "".
 */
function totalStatWord(stat: string): string {
  return stat
    .replace(/\b(game|team|total|totals|over|under)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a total's name counts something other than what the league's default total counts.
 *
 * This is the guard on a *substitution*, and it exists because the failure it prevents is silent
 * and total. `PROPPROFESSOR_GAME_TOTALS` / `PROPPROFESSOR_TEAM_TOTALS` fill in the league's own
 * total for a pick whose name says which total it means only vaguely ("Game Total", "Total") --
 * which is right, and is the whole reason those tables exist. Applied to a name that says exactly
 * which total it means, it stops being a fill-in and becomes an answer about a different market:
 * an NFL "Total Turnovers" pick came back priced as Total Points (41.5), and an MLB "1st Inning
 * Team Total Pitches Thrown" pick came back as 1st-inning Team Total Runs (0.5 at +240). Nothing
 * downstream can catch either one -- `buildRow` stamps every parsed row with the market name the
 * *pick* used, so the row looks like a perfect match for a market it has nothing to do with.
 *
 * So the default may fill in only for a name that names no stat of its own, or that names the
 * default's own stat ("Points" typed as a GAME_TOTAL in a league whose total is Total Points).
 * Anything else is reported unmapped, which is loud and fixable -- a market PropProfessor really
 * carries just needs its line in `PROPPROFESSOR_MARKETS`, and one it does not carry should say so.
 */
function namesADifferentStat(stat: string, leagueDefault: string): boolean {
  const named = totalStatWord(stat);
  return named !== "" && named !== totalStatWord(normalizeMarketName(leagueDefault));
}

export type ResolvedMarket =
  | { ok: true; market: string; league: string }
  /** Knowably unpriceable. Terminal, and not a failure. */
  | { ok: false; kind: "noEquivalent"; detail: string }
  /** We simply have no mapping yet. Must stay loud so a line can be added to the table. */
  | { ok: false; kind: "unmapped"; detail: string };

/**
 * Decides what to ask PropProfessor's screen for, or why it cannot be asked.
 *
 * The three outcomes are deliberately distinct. Collapsing "no book prices this" into "we could not
 * find it" is the exact bug this redesign exists to fix, and collapsing "we have no alias yet" into
 * either one would hide the single maintenance task this design carries.
 */
export function resolveClosingMarket(
  sport: string | null,
  statMarket: string | null,
  marketType: MarketType = "PLAYER_PROP"
): ResolvedMarket {
  const rawStat = normalizeMarketName(statMarket);
  if (!rawStat) return { ok: false, kind: "unmapped", detail: "the pick has no market name" };

  // Stripped off before every check below, and reattached as a suffix by `withPeriod` once the base
  // market is resolved -- it is not a separate request field, see `extractPeriod`.
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
    return { ok: false, kind: "unmapped", detail: `no PropProfessor league for sport "${sport}"` };
  }

  const withPeriod = (market: string): ResolvedMarket => ({
    ok: true,
    market: period ? `${market} - ${period}` : market,
    league,
  });

  // Game markets are named by their type, not by whatever prose the board rendered ("Seattle
  // Seahawks +9" is a Point Spread however it is spelled).
  if (marketType === "MONEYLINE") return withPeriod("Moneyline");
  if (marketType === "SPREAD") return withPeriod("Point Spread");

  const market = PROPPROFESSOR_MARKETS[stat] ?? MARKETS_BY_FILTER_KEY[marketFilterKey(stat)];

  // A team total is keyed by which team, not by the pick's own number, and its screen name is
  // decided by the sport exactly like a game total's is -- checked ahead of `marketType` because a
  // captured team-total pick's own type is not reliable ("Seattle Seahawks Over 24.5" parses as a
  // PLAYER_PROP with the team name read as the player, not as a distinct team-total type).
  if (stat === "team total" || stat === "team totals" || stat.startsWith("team total ")) {
    if (market?.startsWith("Team Total ")) return withPeriod(market);
    const total = PROPPROFESSOR_TEAM_TOTALS[league];
    if (!total) {
      return {
        ok: false,
        kind: "unmapped",
        detail: `no PropProfessor team total for league "${league}"`,
      };
    }
    return namesADifferentStat(stat, total)
      ? { ok: false, kind: "unmapped", detail: `no PropProfessor market alias for "${statMarket}"` }
      : withPeriod(total);
  }

  if (marketType === "GAME_TOTAL") {
    // A board that named the total specifically ("Total Sets", "Total Touchdowns") is taken at its
    // word; a generic one ("Game Total", "Total") gets the league's own total. The alias lookup
    // runs first for the former, so a tennis "Total Sets" is not flattened into "Total Games".
    if (market?.startsWith("Total ")) return withPeriod(market);
    const total = PROPPROFESSOR_GAME_TOTALS[league];
    if (!total) {
      return { ok: false, kind: "unmapped", detail: `no PropProfessor game total for league "${league}"` };
    }
    return namesADifferentStat(stat, total)
      ? { ok: false, kind: "unmapped", detail: `no PropProfessor market alias for "${statMarket}"` }
      : withPeriod(total);
  }

  if (!market) {
    return { ok: false, kind: "unmapped", detail: `no PropProfessor market alias for "${statMarket}"` };
  }
  return withPeriod(market);
}
