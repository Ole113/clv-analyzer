import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findMatchingRow,
  findOddsTerminalFixture,
  normalizeOddsTerminalSnapshot,
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
  type ParseResult,
} from "@clv/shared";
import { DEFAULT_BOOK_ORDER } from "../app-settings";
import { buildClosingVerdict } from "../closing";
import { readRelayedSnapshot } from "../odds-terminal-verdict";

/**
 * The Odds Terminal interpretation path, end to end.
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

function parse(
  plan: OddsTerminalReadPlan,
  matchup = "New York Giants vs Los Angeles Rams",
  options?: { atLine?: number | null }
): ParseResult {
  const result = normalizeOddsTerminalSnapshot(fixture(), plan, resolve(plan, matchup), options);
  expect(result.ok).toBe(true);
  return result;
}

describe("read planning", () => {
  it("maps our league codes onto the sport and league the feed uses", () => {
    expect(planFor("NFL", "Receiving Yards")).toMatchObject({
      sport: "football",
      league: "nfl",
      marketId: "player_receiving_yards",
    });
    expect(planFor("MLB", "Total Bases")).toMatchObject({
      sport: "baseball",
      marketId: "player_total_bases",
    });
  });

  it("keeps the two baseball strikeout markets apart", () => {
    // The single most dangerous collision in the market tables: the same English word is a pitcher
    // market and a batter market, and answering the wrong one would look entirely plausible.
    expect(resolveOddsTerminalMarket("MLB", "PLAYER_PROP", "Pitcher Strikeouts")).toEqual({
      marketId: "player_pitcher_strikeouts",
    });
    expect(resolveOddsTerminalMarket("MLB", "PLAYER_PROP", "Batter Strikeouts")).toEqual({
      marketId: "player_batter_strikeouts",
    });
  });

  it("separates a market this source lacks from one we simply have not mapped", () => {
    // The distinction the three-outcome type exists for: one is a blameless dead end, the other is
    // a gap in our own table that someone should close. Collapsing them hides the second forever.
    expect(resolveOddsTerminalMarket("Tennis", "PLAYER_PROP", "Aces")).toMatchObject({
      kind: "noEquivalent",
    });
    expect(resolveOddsTerminalMarket("NFL", "PLAYER_PROP", "Punts Inside The 20")).toMatchObject({
      kind: "unmapped",
    });
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

describe("snapshot parsing", () => {
  const plan = planFor("NFL", "Receiving Yards");

  it("keeps another fixture's players out of the rows", () => {
    // The flat array holds Tyreek Hill under a different fixture id. A parser that forgot to filter
    // would offer him as a selection in the Giants/Rams game, and the modal would happily show it.
    const players = new Set(parse(plan).rows.map((r) => r.player));
    expect(players).toContain("malik nabers");
    expect(players).toContain("puka nacua");
    expect(players).not.toContain("tyreek hill");
  });

  it("emits an OVER and an UNDER row per player", () => {
    const nabers = parse(plan).rows.filter((r) => r.player === "malik nabers");
    expect(nabers.map((r) => r.side).sort()).toEqual(["OVER", "UNDER"]);
  });

  it("collapses a book's alt line onto its real one", () => {
    // DraftKings quotes 62.5 and 70.5. Its main line is the consensus number the rest of the field
    // is on, not whichever of its own selections happens to price closest to even money.
    const row = parse(plan).rows.find((r) => r.player === "malik nabers" && r.side === "OVER")!;
    const dk = row.bookLines.find((b) => b.bookKey === "draftkings")!;
    expect(dk.line).toBe(62.5);
    expect(dk.price).toBe(-118);
    expect(dk.rawText).toContain("also quoted 70.5");
  });

  it("drops an exchange quote that was never a real market", () => {
    // Novig's only selection is -900/+600 at 45.5 -- a resting order, not a line anyone is offering.
    const row = parse(plan).rows.find((r) => r.player === "malik nabers" && r.side === "OVER")!;
    expect(row.bookLines.map((b) => b.bookKey)).not.toContain("novig");
  });

  it("keeps a multi-word book name and an apostrophe intact", () => {
    // Both broke the first draft of the pair key, which split on spaces: "Hard Rock" became "Hard",
    // and every player's quotes were attributed to the wrong book.
    expect(normalizeOddsTerminalBookKey("Hard Rock")).toBe("hardrock");
    const row = parse(plan).rows.find((r) => r.player === "wandale robinson" && r.side === "OVER");
    expect(row).toBeDefined();
    expect(row!.bookLines.find((b) => b.bookKey === "pinnacle")?.price).toBe(-110);
  });

  it("answers what each book pays at the line actually taken", () => {
    const row = parse(plan, "New York Giants vs Los Angeles Rams", { atLine: 70.5 }).rows.find(
      (r) => r.player === "malik nabers" && r.side === "OVER"
    )!;
    const dk = row.bookLines.find((b) => b.bookKey === "draftkings")!;
    // Its own main line is untouched; the at-line price is carried beside it, never instead of it.
    expect(dk.line).toBe(62.5);
    expect(dk.priceAtLine).toBe(135);
    expect(row.bookLines.find((b) => b.bookKey === "pinnacle")?.priceAtLine).toBeNull();
  });

  it("treats a moneyline's price as its line", () => {
    const mlPlan = planFor("NFL", "Moneyline", "MONEYLINE");
    const rows = parse(mlPlan).rows;
    const giants = rows.find((r) => r.subjectTeam === "New York Giants")!;
    expect(giants.bookLines.find((b) => b.bookKey === "pinnacle")?.line).toBe(145);
    expect(giants.side).toBeNull();
  });

  it("returns a reason rather than throwing on a malformed snapshot", () => {
    for (const bad of [null, 42, {}, { odds: "nope" }]) {
      const result = normalizeOddsTerminalSnapshot(bad, plan, fixtures()[0]);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });
});

describe("the verdict is built the same way every other source's is", () => {
  const plan = planFor("NFL", "Receiving Yards");

  it("shows a DFS column but never averages it", () => {
    // The comparison this modal exists to make: a DFS line beside the sportsbook consensus. It has
    // to be visible and it must not move the average.
    const row = parse(plan).rows.find((r) => r.player === "malik nabers" && r.side === "OVER")!;
    const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 62.5, row, null, "ODDS_TERMINAL", {
      lookup: true,
    });
    const pp = verdict.closeLines.find((l) => l.bookKey === "prizepicks");
    expect(pp).toBeDefined();
    expect(pp!.includedInAverage).toBe(false);
    expect(verdict.closeLines.find((l) => l.bookKey === "pinnacle")!.includedInAverage).toBe(true);
  });

  it("averages the real books onto the consensus line", () => {
    const row = parse(plan).rows.find((r) => r.player === "malik nabers" && r.side === "OVER")!;
    const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 62.5, row, null, "ODDS_TERMINAL", {
      lookup: true,
    });
    expect(verdict.avgClosingLine).toBe(62.5);
    expect(verdict.closingBookCount).toBeGreaterThanOrEqual(3);
  });

  it("filters ODDS_TERMINAL exactly as it filters the other feed sources", () => {
    // If this ever diverges, a difference between the modal's two tabs stops being a difference
    // between sportsbooks and becomes a difference between our own settings -- which is precisely
    // the failure the shared filtering exists to prevent.
    const row = parse(plan).rows.find((r) => r.player === "malik nabers" && r.side === "OVER")!;
    const asTerminal = buildClosingVerdict("PLAYER_PROP", "OVER", 62.5, row, null, "ODDS_TERMINAL", {
      lookup: true,
    });
    const asApi = buildClosingVerdict("PLAYER_PROP", "OVER", 62.5, row, null, "ODDS_API", {
      lookup: true,
    });
    expect(asTerminal.closeLines.map((l) => [l.bookKey, l.includedInAverage])).toEqual(
      asApi.closeLines.map((l) => [l.bookKey, l.includedInAverage])
    );
    expect(asTerminal.avgClosingLine).toBe(asApi.avgClosingLine);
    expect(asTerminal.avgClosingPrice).toBe(asApi.avgClosingPrice);
  });
});

describe("the relayed-snapshot reader", () => {
  const plan = planFor("NFL", "Receiving Yards");
  const item = {
    id: "lookup",
    site: "PROPPROFESSOR" as const,
    fantasyBook: "",
    pageUrl: null,
    gameStartTime: null,
    sport: "NFL",
    statMarket: "Receiving Yards",
    marketType: "PLAYER_PROP" as const,
    player: "Malik Nabers",
    subjectTeam: null,
    matchup: "New York Giants vs Los Angeles Rams",
    side: "OVER" as const,
    takenLine: 62.5,
    externalPropId: null,
  };

  it("matches the pick's own row out of a snapshot it was handed", () => {
    const outcome = readRelayedSnapshot(item, plan, { body: fixture() });
    expect(outcome.kind).toBe("MATCHED");
    if (outcome.kind !== "MATCHED") return;
    expect(outcome.row.player).toBe("malik nabers");
    expect(outcome.row.side).toBe("OVER");
    // The recorded source must not be fetchable. Nothing in this project may hold an Odds Terminal
    // URL that something could later decide to request.
    expect(outcome.source.site).toBe("ODDS_TERMINAL");
    expect(outcome.source.url).not.toMatch(/https?:|oddsterminal/i);
  });

  it("says the selection is absent rather than matching the wrong player", () => {
    const outcome = readRelayedSnapshot({ ...item, player: "Someone Else" }, plan, {
      body: fixture(),
    });
    expect(outcome.kind).toBe("SELECTION_ABSENT");
  });

  it("explains a snapshot that does not carry the pick's game", () => {
    const outcome = readRelayedSnapshot({ ...item, matchup: "Jets vs Patriots" }, plan, {
      body: fixture(),
    });
    expect(outcome.kind).toBe("READ_FAILED");
    if (outcome.kind !== "READ_FAILED") return;
    expect(outcome.reason).toContain("Jets vs Patriots");
  });

  it("fails with a reason rather than throwing on rubbish", () => {
    for (const body of [null, "nope", {}, { fixtures: 3 }]) {
      expect(readRelayedSnapshot(item, plan, { body }).kind).toBe("READ_FAILED");
    }
  });

  it("finds a row the shared matcher agrees with", () => {
    // The matcher is the same one every source goes through; a row this parser produces must be
    // findable by it on the pick's own identity alone.
    const parsed = parse(plan);
    const row = findMatchingRow(parsed.rows, {
      marketType: "PLAYER_PROP",
      statMarket: "Receiving Yards",
      player: "Malik Nabers",
      subjectTeam: null,
      matchup: "New York Giants vs Los Angeles Rams",
      side: "OVER",
      externalPropId: null,
    });
    expect(row?.player).toBe("malik nabers");
  });
});
