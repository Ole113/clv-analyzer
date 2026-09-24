import { describe, expect, it } from "vitest";
import {
  findOddsTerminalFixture,
  oddsTerminalMarketKey,
  oddsTerminalBookChunks,
  oddsTerminalFixturesPath,
  oddsTerminalMarketKeys,
  oddsTerminalNextPage,
  oddsTerminalOddsPath,
  oddsTerminalUrl,
  planOddsTerminalRead,
  normalizeOddsTerminalBookKey,
  ODDS_TERMINAL_BOOKS,
  ODDS_TERMINAL_MAX_BOOKS,
  ODDS_TERMINAL_MAX_BOOK_CHUNKS,
  type OddsTerminalFixture,
} from "@clv/shared";
import { DEFAULT_BOOK_ORDER } from "../app-settings";
import { oddsTerminalPlan } from "./support/odds-terminal-fixture";

/**
 * What a lookup asks Odds Terminal for.
 *
 * Every assertion here is about a property of the live endpoint, each of which the previous
 * implementation got wrong in a way that produced an empty modal rather than an error:
 *
 *  - the slate is **36 hours** unless `start_date_after`/`start_date_before` widen it, so a Sunday
 *    NFL game is invisible on a Wednesday;
 *  - the slate is **paginated at 100**, and a 7-day NCAAF slate is 121 fixtures;
 *  - **player props only exist on a `fixture_id` read** -- the slate response carries main markets
 *    and nothing else;
 *  - **five books, hard**: a sixth `sportsbook` param is `400 Choose between one and five
 *    sportsbooks.`
 *
 * The values (endpoint names, parameter spellings, the five-book ceiling, the 100-per-page slate,
 * the book ids) were all read off live responses on 2026-09-24.
 */

const NOW = new Date("2026-09-24T03:00:00.000Z");

function query(path: string): URLSearchParams {
  return new URL(path, "https://example.invalid").searchParams;
}

describe("the slate request", () => {
  it("asks for a week, not the endpoint's default 36 hours", () => {
    const plan = oddsTerminalPlan("Receptions");
    const params = query(oddsTerminalFixturesPath(plan, { now: NOW }));

    const after = new Date(params.get("start_date_after")!);
    const before = new Date(params.get("start_date_before")!);
    const days = (before.getTime() - after.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(7);

    // The games filter, not a market scope: all/live/upcoming are the only accepted values, and
    // "upcoming" would drop a pick whose game has already kicked off.
    expect(params.get("mode")).toBe("all");
    expect(params.get("league")).toBe("nfl");
    expect(params.get("sport")).toBe("football");
  });

  it("narrows to the hours around the game when the board recorded a kickoff", () => {
    const plan = planOddsTerminalRead({
      sport: "NFL",
      statMarket: "Receptions",
      marketType: "PLAYER_PROP",
      gameStartIso: "2026-09-27T17:00:00Z",
    });
    if ("kind" in plan) throw new Error("expected a plan");

    const params = query(oddsTerminalFixturesPath(plan, { now: NOW }));
    const after = new Date(params.get("start_date_after")!).getTime();
    const before = new Date(params.get("start_date_before")!).getTime();
    const kickoff = new Date("2026-09-27T17:00:00Z").getTime();

    expect(after).toBeLessThan(kickoff);
    expect(before).toBeGreaterThan(kickoff);
    // Tight enough that a whole Sunday slate is not in the answer, which is what makes two games
    // answering to one matchup rare rather than routine.
    expect((before - after) / 3_600_000).toBeLessThanOrEqual(24);
  });

  it("asks for one book, because a slate read throws its odds away", () => {
    const plan = oddsTerminalPlan("Receptions");
    expect(query(oddsTerminalFixturesPath(plan, { now: NOW })).getAll("sportsbook")).toHaveLength(1);
  });

  it("follows pagination, and stops at the planner's cap", () => {
    // 100 per page is the endpoint's own size; a 7-day NCAAF slate was 121 fixtures over 2 pages.
    expect(oddsTerminalNextPage({ totalPages: 2, hasMore: true }, 1)).toBe(2);
    expect(oddsTerminalNextPage({ totalPages: 2, hasMore: false }, 2)).toBeNull();
    expect(oddsTerminalNextPage({ totalPages: 1, hasMore: false }, 1)).toBeNull();
    // A response claiming endless pages must not produce an endless read.
    expect(oddsTerminalNextPage({ totalPages: 99, hasMore: true }, 4)).toBeNull();
    expect(query(oddsTerminalFixturesPath(oddsTerminalPlan("Receptions"), { page: 2 })).get("page")).toBe("2");
  });
});

describe("the odds request", () => {
  it("names the fixture, which is what makes player props appear at all", () => {
    const plan = oddsTerminalPlan("Receptions");
    const params = query(oddsTerminalOddsPath(plan, "20260927D946A16B"));
    expect(params.get("fixture_id")).toBe("20260927D946A16B");
    expect(params.get("mode")).toBe("all");
    // No market parameter: the endpoint ignores one (verified live -- passing
    // `market=player_receiving_yards` still returned all 112 markets), so the filtering is ours.
    expect(params.get("market")).toBeNull();
  });

  it("never asks for more books than the endpoint accepts", () => {
    const chunks = oddsTerminalBookChunks(DEFAULT_BOOK_ORDER);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(ODDS_TERMINAL_MAX_BOOK_CHUNKS);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(ODDS_TERMINAL_MAX_BOOKS);
      expect(chunk.length).toBeGreaterThan(0);
    }
    // No book asked for twice: a duplicate would waste one of only five slots.
    const all = chunks.flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("ranks the books by the user's own order, and keeps prop-carrying books reachable", () => {
    const order = ["circa", "fanduel", "pinnacle", "betonline", "novig", "draftkings"];
    const chunks = oddsTerminalBookChunks(order);
    expect(chunks[0][0]).toBe("circa_sports");
    expect(chunks[0][1]).toBe("fanduel");
    // DraftKings is ranked sixth here and quotes more player markets than any other book on this
    // feed. Ranking alone would leave it out; the second chunk is why a read can still reach it.
    expect(chunks.flat()).toContain("draftkings");
  });

  it("only ever produces relative paths, so nothing can redirect a read off-site", () => {
    const plan = oddsTerminalPlan("Receptions");
    for (const path of [oddsTerminalFixturesPath(plan), oddsTerminalOddsPath(plan, "abc")]) {
      expect(path.startsWith("/api/")).toBe(true);
      expect(path).not.toMatch(/https?:/);
    }
    // And the one place an origin is added refuses anything that is not one of those paths.
    expect(oddsTerminalUrl("/api/snapshot?x=1")).toBe("https://oddsterminal.org/api/snapshot?x=1");
    expect(() => oddsTerminalUrl("https://example.com/api/snapshot")).toThrow();
    expect(() => oddsTerminalUrl("//evil.example")).toThrow();
  });
});

describe("the books table", () => {
  it("uses the ids the catalog actually publishes", () => {
    // Every one of these is a spelling that cannot be derived from the display name, which is why
    // they were read out of `/api/catalog` rather than guessed. `sportsbook=hardrock` returns
    // nothing at all, silently.
    const byKey = new Map(ODDS_TERMINAL_BOOKS.map((b) => [b.key, b]));
    expect(byKey.get("hardrock")?.id).toBe("hard_rock");
    expect(byKey.get("circa")?.id).toBe("circa_sports");
    expect(byKey.get("polymarketus")?.id).toBe("polymarket_usa_");
    expect(byKey.get("prophet")?.id).toBe("prophet_x");
    expect(byKey.get("bet365")?.id).toBe("bet365");
  });

  it("reads a response by the display name, which is a different string", () => {
    // The query takes the id and the response carries the name; keeping only one of the two means
    // either an unanswerable query or unattributable rows.
    expect(normalizeOddsTerminalBookKey("Hard Rock")).toBe("hardrock");
    expect(normalizeOddsTerminalBookKey("Polymarket (USA)")).toBe("polymarketus");
    expect(normalizeOddsTerminalBookKey("Circa Sports")).toBe("circa");
    expect(normalizeOddsTerminalBookKey("bet365")).toBe("bet365");
  });

  it("lists no book the catalog does not carry", () => {
    // ESPN BET is in the catalog's own `missing` list and Underdog is absent entirely. Asking for
    // a book this feed does not know burns one of five slots and returns nothing.
    const ids = ODDS_TERMINAL_BOOKS.map((b) => b.id);
    expect(ids).not.toContain("espnbet");
    expect(ids).not.toContain("underdog");
  });
});

describe("which market names count as an answer", () => {
  const keys = (sport: string, market: string, type: Parameters<typeof oddsTerminalMarketKeys>[1] = "PLAYER_PROP") =>
    oddsTerminalMarketKeys(sport, type, market);

  it("matches a board's spelling to the feed's, both ways round", () => {
    // "Receptions" on one board, "Player Receptions" on the other, "Player Receptions" on the feed.
    expect(keys("NFL", "Receptions")).toContain("receptions");
    expect(keys("NFL", "Player Receptions")).toContain("receptions");
  });

  it("reaches the feed's name through this project's canonical vocabulary", () => {
    // The board writes "SOG"; the feed says "Player Shots On Goal". Neither normalization nor a
    // literal comparison gets there -- `resolveClosingMarket` does.
    expect(keys("NHL", "SOG")).toContain("shots on goal");
    expect(keys("MLB", "Bases")).toContain("bases");
    expect(keys("NBA", "Threes Made")).toContain("three pointers made");
  });

  it("moves a period qualifier to the front, where this feed puts it", () => {
    // Our vocabulary spells it "Player Touchdowns - 1st Half"; the feed spells the same market
    // "1st Half Player Touchdowns".
    expect(keys("NFL", "1st Half Touchdowns")).toContain("1st half player touchdowns");
  });

  it("never lets a period-qualified pick match the full-game market", () => {
    // The worst available failure mode: a wrong answer that parses perfectly. A first-half prop
    // priced as a full-game prop would look entirely reasonable on screen.
    expect(keys("NFL", "1st Half Receptions")).not.toContain("receptions");
    expect(keys("NFL", "Receptions")).not.toContain("1st half receptions");
  });

  it("names each sport family's own game markets", () => {
    expect(keys("NFL", "Point Spread", "SPREAD")).toContain("point spread");
    expect(keys("MLB", "Run Line", "SPREAD")).toContain("run line");
    expect(keys("NHL", "Puck Line", "SPREAD")).toContain("puck line");
    expect(keys("MLB", "Game Total", "GAME_TOTAL")).toContain("total runs");
    expect(keys("NHL", "Game Total", "GAME_TOTAL")).toContain("total goals");
    expect(keys("NFL", "Moneyline", "MONEYLINE")).toEqual(["moneyline"]);
    // Team totals are carried under one name in every sport, and used to be reported unsupported.
    expect(keys("NFL", "Team Total", "GAME_TOTAL")).toContain("team total");
  });

  it("refuses a sport this source does not cover, rather than guessing", () => {
    const planned = planOddsTerminalRead({
      sport: "ATP",
      statMarket: "Aces",
      marketType: "PLAYER_PROP",
    });
    expect(planned).toMatchObject({ kind: "noEquivalent" });
  });
});

describe("finding the pick's game", () => {
  const fixture = (
    id: string,
    league: string,
    away: string,
    home: string,
    start = "2026-09-27T17:00:00Z"
  ): OddsTerminalFixture => ({
    id,
    league: { id: league, name: league.toUpperCase() },
    start_date: start,
    is_live: false,
    home_team_display: home,
    away_team_display: away,
  });

  const plan = () => oddsTerminalPlan("Receptions");

  it("matches a matchup written in either orientation", () => {
    const fixtures = [fixture("a", "nfl", "Kansas City Chiefs", "Miami Dolphins")];
    for (const matchup of ["Kansas City Chiefs @ Miami Dolphins", "Miami Dolphins vs. Kansas City Chiefs"]) {
      expect(findOddsTerminalFixture(fixtures, plan(), { matchup, subjectTeam: null })?.id).toBe("a");
    }
  });

  it("does not answer an NFL question with a college game", () => {
    // One `sport=football` slate carries NFL, NCAAF and CFL together, and college team names
    // collide with professional ones constantly.
    const fixtures = [fixture("college", "ncaaf", "Miami", "Kansas")];
    expect(
      findOddsTerminalFixture(fixtures, plan(), {
        matchup: "Miami @ Kansas",
        subjectTeam: null,
      })
    ).toBeNull();
  });

  it("refuses when two games answer to one matchup", () => {
    const fixtures = [
      fixture("a", "nfl", "Kansas City Chiefs", "Miami Dolphins", "2026-09-27T17:00:00Z"),
      fixture("b", "nfl", "Kansas City Chiefs", "Miami Dolphins", "2026-09-28T17:00:00Z"),
    ];
    expect(
      findOddsTerminalFixture(fixtures, plan(), {
        matchup: "Kansas City Chiefs @ Miami Dolphins",
        subjectTeam: null,
      })
    ).toBeNull();
  });

  it("uses the pick's own kickoff to separate two games that really are different", () => {
    const planned = planOddsTerminalRead({
      sport: "MLB",
      statMarket: "Hits",
      marketType: "PLAYER_PROP",
      gameStartIso: "2026-09-24T17:05:00Z",
    });
    if ("kind" in planned) throw new Error("expected a plan");

    // A doubleheader: same two clubs, same day, hours apart.
    const fixtures = [
      fixture("game1", "mlb", "St. Louis Cardinals", "Pittsburgh Pirates", "2026-09-24T17:05:00Z"),
      fixture("game2", "mlb", "St. Louis Cardinals", "Pittsburgh Pirates", "2026-09-24T23:05:00Z"),
    ];
    expect(
      findOddsTerminalFixture(fixtures, planned, {
        matchup: "St. Louis Cardinals @ Pittsburgh Pirates",
        subjectTeam: null,
      })?.id
    ).toBe("game1");
  });

  it("falls back to the team on a game market with no matchup", () => {
    const fixtures = [fixture("a", "nfl", "Kansas City Chiefs", "Miami Dolphins")];
    expect(
      findOddsTerminalFixture(fixtures, plan(), { matchup: null, subjectTeam: "Dolphins" })?.id
    ).toBe("a");
  });
});

/**
 * Every market this install has actually captured, against the names the feed actually uses.
 *
 * This is the "does the odds button work for all my props" question, asked as a test rather than
 * hoped for. The left column is every distinct `(sport, marketType, statMarket)` in the user's own
 * database; the right is market names read off live fixture responses on 2026-09-24 (NFL: Chiefs
 * at Dolphins with five books; MLB: Marlins at Cubs with five books, PrizePicks among them).
 *
 * A market that stops resolving here is a market whose modal comes back empty, which is exactly
 * the failure this source had for every prop before it was rewritten -- so it is worth pinning,
 * and worth extending whenever a new spelling reaches the database.
 */
describe("every market this install has captured resolves to a name the feed uses", () => {
  const LIVE_MARKETS: Record<string, string[]> = {
    NFL: [
      "Player Receptions", "Player Receiving Yards", "Player Rushing Yards", "Player Rushing Attempts",
      "Player Passing Yards", "Player Passing Attempts", "Player Passing Completions",
      "Player Passing Touchdowns", "Player Interceptions", "Player Rushing + Receiving Yards",
      "Player Passing + Rushing Yards", "Player Touchdowns", "Player Kicking Points",
      "Player Longest Rush", "Player Longest Reception", "Player Longest Passing Completion",
      "Player Sacks", "Player Field Goals Made", "Anytime Touchdown Scorer", "First Touchdown Scorer",
      "1st Half Player Touchdowns", "Point Spread", "Total Points", "Moneyline", "Team Total",
    ],
    NCAAF: [
      "Player Receptions", "Player Receiving Yards", "Player Rushing Yards", "Player Passing Yards",
      "Player Passing Touchdowns", "Point Spread", "Total Points", "Moneyline",
      "1st Quarter Point Spread",
    ],
    MLB: [
      "Player Bases", "Player Batting Walks", "Player Doubles", "Player Earned Runs", "Player Hits",
      "Player Hits + Runs + RBIs", "Player Home Runs", "Player RBIs", "Player Runs", "Player Singles",
      "Player Strikeouts", "Player Triples", "Run Line", "Total Runs", "Moneyline", "Total Hits",
    ],
    WNBA: [
      "Player Points", "Player Rebounds", "Player Assists", "Player Three Pointers Made",
      "Point Spread", "Total Points", "Moneyline",
    ],
  };

  const CAPTURED: [string, Parameters<typeof oddsTerminalMarketKeys>[1], string][] = [
    ["NFL", "PLAYER_PROP", "Receptions"],
    ["NFL", "PLAYER_PROP", "Player Receptions"],
    ["NFL", "PLAYER_PROP", "Receiving Yards"],
    ["NFL", "PLAYER_PROP", "Player Receiving Yards"],
    ["NFL", "PLAYER_PROP", "Player Rushing Yards"],
    ["NFL", "PLAYER_PROP", "Rushing Attempts"],
    ["NFL", "PLAYER_PROP", "Player Rushing Attempts"],
    ["NFL", "PLAYER_PROP", "Interceptions"],
    ["NFL", "PLAYER_PROP", "Player Sacks"],
    ["NFL", "PLAYER_PROP", "Player Touchdowns"],
    ["NFL", "PLAYER_PROP", "Player Field Goals Made"],
    ["NFL", "PLAYER_PROP", "Longest Rush"],
    ["NFL", "PLAYER_PROP", "Player Longest Reception"],
    ["NCAAF", "PLAYER_PROP", "Rushing Yards"],
    ["NCAAF", "PLAYER_PROP", "Receiving Yards"],
    ["NCAAF", "PLAYER_PROP", "Player Receptions"],
    ["NCAAF", "PLAYER_PROP", "Player Passing Touchdowns"],
    ["NCAAF", "GAME_TOTAL", "Total Points"],
    ["NCAAF", "SPREAD", "1st Quarter Point Spread"],
    ["MLB", "PLAYER_PROP", "Strikeouts"],
    ["MLB", "PLAYER_PROP", "Player Strikeouts"],
    ["MLB", "PLAYER_PROP", "Player Hits"],
    ["MLB", "PLAYER_PROP", "Bases"],
    ["MLB", "PLAYER_PROP", "Hits + Runs + RBIs"],
    ["MLB", "PLAYER_PROP", "Player Hits + Runs + RBIs"],
    ["MLB", "GAME_TOTAL", "Total Hits"],
    ["WNBA", "PLAYER_PROP", "Player Assists"],
  ];

  it.each(CAPTURED)("%s %s %s", (sport, marketType, statMarket) => {
    const keys = oddsTerminalMarketKeys(sport, marketType, statMarket);
    const live = LIVE_MARKETS[sport].map(oddsTerminalMarketKey);
    expect(keys.some((key) => live.includes(key)), `keys: ${keys.join(", ")}`).toBe(true);
  });

  it("says so plainly for the two things this feed genuinely does not have", () => {
    // Both are real gaps rather than spelling problems, and both should read as a flat "not
    // covered" rather than an empty table:
    //
    //  - tennis is not in `ODDS_TERMINAL_SPORTS` at all, because our league vocabulary collapses
    //    every tournament into "ATP"/"WTA" and this feed keys them per competition;
    //  - an MLB "Outs" prop (pitcher outs recorded) was not quoted by any of the five books on a
    //    live Cubs game -- the modal names what the fixture *was* quoting instead.
    expect(planOddsTerminalRead({ sport: "ATP", statMarket: "Aces", marketType: "PLAYER_PROP" }))
      .toMatchObject({ kind: "noEquivalent" });

    const outs = oddsTerminalMarketKeys("MLB", "PLAYER_PROP", "Outs");
    expect(outs.length).toBeGreaterThan(0);
    expect(LIVE_MARKETS.MLB.map(oddsTerminalMarketKey)).not.toContain(outs[0]);
  });
});
