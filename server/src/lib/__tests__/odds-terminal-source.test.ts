import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findOddsTerminalFixture,
  oddsTerminalBooks,
  oddsTerminalSnapshotPath,
  planOddsTerminalRead,
  resolveOddsTerminalMarket,
  normalizeOddsTerminalBookKey,
  ODDS_TERMINAL_BOOKS,
  ODDS_TERMINAL_MAX_BOOKS,
  type MarketType,
  type OddsTerminalFixture,
  type OddsTerminalReadPlan,
} from "@clv/shared";
import { DEFAULT_BOOK_ORDER } from "../app-settings";
import { resolveRelayedFixture } from "../odds-terminal-verdict";

/**
 * Odds Terminal's snapshot: read planning, and the one job the snapshot still has.
 *
 * It is no longer an odds source. `/api/snapshot` serves main markets only (verified live across
 * all sixteen sports), so the odds come from `/api/stream` -- covered by
 * `odds-terminal-stream.test.ts`. What remains here is what the snapshot is still fetched for:
 * resolving *which fixture* a pick is about, since the stream demands a `fixture_id` and will not
 * hand one out.
 *
 * The fixture is shaped as the live `/api/snapshot` response was observed to be, and carries the
 * structural traps that actually break a parser of this kind:
 *
 *  - **A flat `odds[]` array covering three fixtures at once**, which is the one real structural
 *    difference from The Odds API and the thing most likely to leak another game's numbers into a
 *    row. Two of those fixtures name the same two teams.
 *  - **A decoy NCAAF fixture with identical team names**, because one `sport=football` snapshot
 *    carries every football league together. Getting this wrong means quietly answering an NFL
 *    question with a college game.
 *  - **A book quoting two lines for one player** (DraftKings on 62.5 and 70.5), so alt-line
 *    collapsing is exercised rather than assumed.
 *  - **An exchange resting a quote nowhere near the market** (Novig at -900/+600).
 *  - **A fixed-payout DFS column** (PrizePicks at -119/-119), which must be shown but never
 *    averaged.
 *  - **A multi-word book name and an apostrophe in a player name**, the two things that broke the
 *    first draft of the pair-keying in this parser.
 */

const FIXTURES = join(__dirname, "../../../../shared/src/__fixtures__");

function fixture(): unknown {
  return JSON.parse(
    readFileSync(join(FIXTURES, "odds-terminal-nfl-receiving-yards.json"), "utf8")
  );
}

function planFor(
  sport: string,
  statMarket: string,
  marketType: MarketType = "PLAYER_PROP"
): OddsTerminalReadPlan {
  const plan = planOddsTerminalRead({ sport, statMarket, marketType });
  if ("kind" in plan) throw new Error(`expected a plan, got ${plan.kind}: ${plan.reason}`);
  return plan;
}

function fixtures(): OddsTerminalFixture[] {
  return (fixture() as { fixtures: OddsTerminalFixture[] }).fixtures;
}

function resolve(plan: OddsTerminalReadPlan, matchup: string): OddsTerminalFixture {
  const found = findOddsTerminalFixture(fixtures(), plan, { matchup, subjectTeam: null });
  if (!found) throw new Error(`no fixture for ${matchup}`);
  return found;
}

describe("read planning", () => {
  it("maps our league codes onto the sport and league the feed uses", () => {
    expect(planFor("NFL", "Receiving Yards")).toMatchObject({
      sport: "football",
      league: "nfl",
    });
    // A prop carries no feed-side market id at all -- see the next case.
    expect(planFor("MLB", "Total Bases")).toMatchObject({
      sport: "baseball",
      league: "mlb",
      marketId: null,
    });
  });

  it("needs no market id for a player prop", () => {
    // The point of deleting the prop table. A prop plans successfully whatever it is called,
    // because the market is matched by NAME against what the stream returns -- so this source now
    // works for any prop the site carries, not just the ones somebody remembered to type in.
    for (const market of ["Hits + Runs + RBIs", "Punts Inside The 20", "Anything At All"]) {
      const plan = planOddsTerminalRead({ sport: "MLB", statMarket: market, marketType: "PLAYER_PROP" });
      expect("kind" in plan, `${market} should plan`).toBe(false);
      if ("kind" in plan) continue;
      expect(plan.marketId).toBeNull();
      expect(plan.requestedStatMarket).toBe(market);
    }
  });

  it("refuses the sports whose leagues our vocabulary has collapsed", () => {
    // Same honest refusal The Odds API path makes: "Soccer" names no competition this feed keys by,
    // and guessing one would answer about a different match entirely.
    expect(planOddsTerminalRead({ sport: "Soccer", statMarket: "Shots", marketType: "PLAYER_PROP" }))
      .toMatchObject({ kind: "noEquivalent" });
  });

  it("asks for no more books than the endpoint accepts", () => {
    // The API 400s outright above five, so this is a hard limit rather than a budget: exceeding it
    // returns nothing at all, for every market, silently.
    expect(oddsTerminalBooks(DEFAULT_BOOK_ORDER).length).toBeLessThanOrEqual(ODDS_TERMINAL_MAX_BOOKS);
    expect(ODDS_TERMINAL_MAX_BOOKS).toBe(5);
    expect(oddsTerminalBooks([]).length).toBe(5);
  });

  it("spends its five slots on the books the user ranked highest", () => {
    const chosen = oddsTerminalBooks(["novig", "prizepicks", "pinnacle"]);
    expect(chosen.slice(0, 3)).toEqual(["novig", "prizepicks", "pinnacle"]);
  });

  it("puts book ids in the query, not display names", () => {
    // The two are not interchangeable: `sportsbook=` takes the lowercase id while the response
    // spells the same book as a display name. Sending "DraftKings" is not what the endpoint wants,
    // and "Hard Rock" is `hard_rock` -- not the `hardrock` our own normalizer would produce.
    const ids = oddsTerminalBooks([]);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9_]+$/);
    expect(ODDS_TERMINAL_BOOKS.find((b) => b.name === "Hard Rock")?.id).toBe("hard_rock");
    expect(ODDS_TERMINAL_BOOKS.find((b) => b.name === "Hard Rock")?.key).toBe("hardrock");
  });

  it("asks for no book this source does not offer", () => {
    // ESPN BET, Prophet X and Underdog were in this table and are not among the 216 books the
    // catalog lists. With only five slots, asking for one that cannot exist wastes a slot.
    const names = ODDS_TERMINAL_BOOKS.map((b) => b.name);
    for (const absent of ["ESPNBet", "ESPN BET", "ProphetX", "Prophet X", "Underdog"]) {
      expect(names).not.toContain(absent);
    }
  });

  it("uses each sport's own game-market ids", () => {
    // The id for "the spread" is a different word in every sport, and game markets are the only
    // thing this source actually serves -- so getting these wrong breaks everything that works.
    expect(resolveOddsTerminalMarket("NFL", "SPREAD", "Spread")).toEqual({
      marketId: "point_spread",
    });
    expect(resolveOddsTerminalMarket("MLB", "SPREAD", "Run Line")).toEqual({
      marketId: "run_line",
    });
    expect(resolveOddsTerminalMarket("NHL", "SPREAD", "Puck Line")).toEqual({
      marketId: "puck_line",
    });
    expect(resolveOddsTerminalMarket("MLB", "GAME_TOTAL", "Total Runs")).toEqual({
      marketId: "total_runs",
    });
    expect(resolveOddsTerminalMarket("NHL", "GAME_TOTAL", "Total Goals")).toEqual({
      marketId: "total_goals",
    });
    expect(resolveOddsTerminalMarket("NBA", "MONEYLINE", "Moneyline")).toEqual({
      marketId: "moneyline",
    });
  });

  it("refuses a team total rather than inventing an id for it", () => {
    // Not a main market, and main markets are all this endpoint serves. A guessed id would render
    // as an empty tab indistinguishable from "no market yet".
    expect(resolveOddsTerminalMarket("NFL", "GAME_TOTAL", "Team Total Points")).toMatchObject({
      kind: "noEquivalent",
    });
  });

  it("builds a relative path and never an absolute URL", () => {
    // The property the whole architecture rests on: this cannot express a cross-origin request, so
    // no caller -- server, worker or content script -- can turn a plan into outbound traffic.
    const path = oddsTerminalSnapshotPath(planFor("NFL", "Receiving Yards"));
    expect(path.startsWith("/api/snapshot?")).toBe(true);
    expect(path).not.toMatch(/https?:|oddsterminal/i);
    expect(path.match(/sportsbook=/g)?.length).toBeLessThanOrEqual(ODDS_TERMINAL_MAX_BOOKS);
  });
});

describe("fixture resolution", () => {
  const plan = planFor("NFL", "Receiving Yards");

  it("finds the game either way round", () => {
    expect(resolve(plan, "New York Giants vs Los Angeles Rams").id).toBe("fixture-nyg-lar");
    expect(resolve(plan, "Los Angeles Rams vs New York Giants").id).toBe("fixture-nyg-lar");
    expect(resolve(plan, "Giants @ Rams").id).toBe("fixture-nyg-lar");
  });

  it("does not answer an NFL question with the NCAAF game of the same name", () => {
    // Both fixtures name the Giants and the Rams; only the league tells them apart, and one
    // `sport=football` snapshot always carries both.
    const ncaaf = planFor("NCAAF", "Receiving Yards");
    expect(resolve(ncaaf, "New York Giants vs Los Angeles Rams").id).toBe("fixture-ncaaf-decoy");
    expect(resolve(plan, "New York Giants vs Los Angeles Rams").id).toBe("fixture-nyg-lar");
  });

  it("refuses a fixture whose league cannot be confirmed", () => {
    // Fails closed. An unlabelled fixture in a multi-league snapshot is not assumed to be ours.
    const unlabelled = [{ ...fixtures()[0], league: undefined }];
    expect(
      findOddsTerminalFixture(unlabelled, plan, {
        matchup: "New York Giants vs Los Angeles Rams",
        subjectTeam: null,
      })
    ).toBeNull();
  });

  it("refuses when two fixtures in the same league match one matchup", () => {
    // Ambiguity is a failure, not a coin toss. Two fixtures matching one matchup means the team
    // names did not actually identify a game, and returning either would produce a row that parses
    // perfectly while describing the wrong fixture -- far worse than returning nothing.
    const twice = [...fixtures(), { ...fixtures()[0], id: "fixture-nyg-lar-again" }];
    expect(
      findOddsTerminalFixture(twice, plan, {
        matchup: "New York Giants vs Los Angeles Rams",
        subjectTeam: null,
      })
    ).toBeNull();
  });

  it("refuses rather than guessing when a matchup names no game", () => {
    expect(
      findOddsTerminalFixture(fixtures(), plan, { matchup: "Jets vs Patriots", subjectTeam: null })
    ).toBeNull();
    expect(
      findOddsTerminalFixture(fixtures(), plan, { matchup: null, subjectTeam: null })
    ).toBeNull();
  });
});
