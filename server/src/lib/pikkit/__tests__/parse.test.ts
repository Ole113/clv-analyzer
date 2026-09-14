import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../csv";
import { parseLeg, parseLegs, parsePikkitRow, PikkitRowError, splitTagSet } from "../parse";

/**
 * Leg parsing, once per book's format.
 *
 * Each of the seven apps writes a leg differently, and the parser does not branch per book -- it
 * finds the market from a vocabulary and cuts either side of it. That makes these cases the real
 * specification of the approach: if the vocabulary stops covering a book, the case for that book
 * fails here rather than the market breakdown quietly losing a fifth of its rows in production.
 */
describe("parseLeg, per sportsbook format", () => {
  it("reads Dabble's lowercase kebab markets", () => {
    expect(parseLeg("Over 0.5 Javonte Williams anytime-touchdown Dallas Cowboys @ New York Giants", 0)).toMatchObject({
      side: "OVER",
      line: 0.5,
      player: "Javonte Williams",
      marketKey: "anytime-touchdown",
      matchup: "Dallas Cowboys @ New York Giants",
    });
  });

  it("reads Underdog's Higher/Lower and drops its redundant O/U marker", () => {
    expect(parseLeg("Higher 1.5 Corbin Carroll Hits + Runs + RBIs O/U TEX @ AZ", 0)).toMatchObject({
      side: "OVER",
      line: 1.5,
      player: "Corbin Carroll",
      marketKey: "hits-runs-rbis",
      matchup: "TEX @ AZ",
    });
  });

  it("reads Betr's abbreviated markets", () => {
    expect(parseLeg("Over 32.5 Tyler Shough Pass Atts NO vs. DET", 0)).toMatchObject({
      side: "OVER",
      line: 32.5,
      player: "Tyler Shough",
      marketKey: "passing-attempts",
      matchup: "NO vs. DET",
    });
  });

  it("reads Courtside, where the player comes before the side", () => {
    expect(parseLeg("Xavier McKinney over 6.5 Player Tackles + Assists Green Bay Packers @ Minnesota Vikings", 0)).toMatchObject({
      side: "OVER",
      line: 6.5,
      player: "Xavier McKinney",
      marketKey: "tackles-assists",
      matchup: "Green Bay Packers @ Minnesota Vikings",
    });
  });

  it("reads Fliff's all-caps markets without swallowing the team abbreviation after them", () => {
    // "WSH" is as capitalised as "TACKLES" is, so any rule based on letter case would take it into
    // the market. The vocabulary is what stops the cut in the right place.
    expect(parseLeg("Andrew Mukuba Under 4.5 TACKLES + ASSISTS WSH Commanders vs PHI Eagles", 0)).toMatchObject({
      side: "UNDER",
      line: 4.5,
      player: "Andrew Mukuba",
      marketKey: "tackles-assists",
      matchup: "WSH Commanders vs PHI Eagles",
    });
  });

  it("reads Novig's single-letter sides", () => {
    expect(parseLeg("Elmer Rodriguez-Cruz U 14.5 Outs Recorded New York Yankees @ Los Angeles Angels", 0)).toMatchObject({
      side: "UNDER",
      line: 14.5,
      player: "Elmer Rodriguez-Cruz",
      marketKey: "outs-recorded",
      matchup: "New York Yankees @ Los Angeles Angels",
    });
  });

  it("reads Rebet's bracketed handicap lines", () => {
    expect(parseLeg("Bayern Munich (-1.5) 1st half - corner handicap Bayern Munich @ SV 07 Elversberg", 0)).toMatchObject({
      side: null,
      line: -1.5,
      marketKey: "1h-corner-handicap",
    });
  });

  it("reads a line written before the side", () => {
    expect(parseLeg("48.5 Over Larry Rountree III Rush Yards Hamilton Tiger-Cats @ Calgary Stampeders", 0)).toMatchObject({
      side: "OVER",
      line: 48.5,
      player: "Larry Rountree III",
      marketKey: "rushing-yards",
    });
  });
});

describe("parseLeg, the cuts that are easy to get wrong", () => {
  it("takes the longest market phrase, not the first component of it", () => {
    // "Hits + Runs + RBIs" contains both "Hits" and "RBIs". Filing this under "hits" would put
    // every multi-stat prop into one of its parts and push the rest into the matchup.
    expect(parseLeg("Higher 0.5 Josh Smith Hits + Runs + RBIs O/U BAL @ TOR", 0).marketKey).toBe("hits-runs-rbis");
    expect(parseLeg("Higher 0.5 Josh Smith Total Bases O/U BAL @ TOR", 0).marketKey).toBe("total-bases");
  });

  it("collapses every book's spelling of receiving yards onto one key", () => {
    const keys = [
      "Higher 18.5 Rhamondre Stevenson Receiving Yards O/U NE @ SEA",
      "Over 50.5 Evan Stewart Receiving Yds ORE vs. OKST",
      "Over 28.5 Bijan Robinson receiving-yards Atlanta Falcons @ Pittsburgh Steelers",
      "Michael Mayer Under 26.5 RECEIVING YARDS MIA Dolphins vs LV Raiders",
    ].map((leg) => parseLeg(leg, 0).marketKey);
    expect(new Set(keys)).toEqual(new Set(["receiving-yards"]));
  });

  it("leaves the player null on a whole-game market, where those words are a team", () => {
    const leg = parseLeg("LIU Sharks +39.5 Spread Long Island University @ Kansas", 0);
    expect(leg.marketKey).toBe("spread");
    expect(leg.player).toBeNull();
  });

  it("keeps an unrecognised leg's raw text rather than guessing at it", () => {
    const leg = parseLeg("Over 2.5 Someone Quantum Flux Widgets ABC @ XYZ", 0);
    expect(leg.rawText).toBe("Over 2.5 Someone Quantum Flux Widgets ABC @ XYZ");
    expect(leg.marketKey).toBeNull();
    expect(leg.side).toBe("OVER");
  });

  it("does not read an unsigned number inside a team name as the line", () => {
    // "SV 07 Elversberg" and "Charlotte 49ers" both carry a bare number. Only the signed or
    // bracketed form is a line when no side word sits beside it.
    const leg = parseLeg("Charlotte 49ers (+20.5) Handicap (incl. overtime) Charlotte 49ers @ Appalachian State Mountaineers", 0);
    expect(leg.line).toBe(20.5);
    expect(leg.marketKey).toBe("spread");
  });

  it("splits a slip on its leg delimiter", () => {
    const legs = parseLegs("Over 0.5 A Hits X @ Y | Under 1.5 B Runs P @ Q");
    expect(legs.map((l) => l.marketKey)).toEqual(["hits", "runs"]);
    expect(legs.map((l) => l.legIndex)).toEqual([0, 1]);
  });
});

describe("parsePikkitRow", () => {
  const base = {
    bet_id: "abc",
    sportsbook: "Novig",
    type: "straight",
    status: "SETTLED_WIN",
    odds: "2.5",
    closing_line: "2.2",
    ev: "0.05",
    amount: "10",
    profit: "15.00",
    time_placed_iso: "2026-09-13T20:02:30.848Z",
    time_settled_iso: "2026-09-14T03:50:46.178Z",
    bet_info: "Over 0.5 A Hits X @ Y",
    tags: "",
    sports: "Baseball",
    leagues: "MLB",
  };

  it("narrows the export's status vocabulary", () => {
    expect(parsePikkitRow({ ...base, status: "SETTLED_LOSS" }).result).toBe("LOSS");
    expect(parsePikkitRow({ ...base, status: "SETTLED_VOID" }).result).toBe("VOID");
    expect(parsePikkitRow({ ...base, status: "PLACED" }).result).toBe("PENDING");
  });

  it("refuses a status it does not recognise instead of defaulting", () => {
    // Defaulting would store the bet as pending forever, with nothing downstream able to tell.
    expect(() => parsePikkitRow({ ...base, status: "SETTLED_SOMETHING" })).toThrow(PikkitRowError);
  });

  it("flags a loss that cost nothing as no-risk", () => {
    expect(parsePikkitRow({ ...base, status: "SETTLED_LOSS", profit: "0.00" }).noRisk).toBe(true);
    expect(parsePikkitRow({ ...base, status: "SETTLED_LOSS", profit: "-10.00" }).noRisk).toBe(false);
    // A win at zero profit is not the same thing and must not be flagged.
    expect(parsePikkitRow({ ...base, status: "SETTLED_WIN", profit: "0.00" }).noRisk).toBe(false);
  });

  it("leaves the closing line and EV null when the book reported neither", () => {
    const bet = parsePikkitRow({ ...base, closing_line: "", ev: "" });
    expect(bet.closingDecimal).toBeNull();
    expect(bet.pikkitEv).toBeNull();
  });

  it("treats an unsettled bet as having no settle time", () => {
    expect(parsePikkitRow({ ...base, status: "PLACED", time_settled_iso: "" }).settledAt).toBeNull();
  });

  it("reads the Live tag", () => {
    expect(parsePikkitRow({ ...base, tags: "Live " }).isLive).toBe(true);
    expect(parsePikkitRow(base).isLive).toBe(false);
  });

  it("refuses a row with an unreadable stake", () => {
    expect(() => parsePikkitRow({ ...base, amount: "" })).toThrow(PikkitRowError);
  });
});

describe("splitTagSet", () => {
  it("splits the export's joined sets and drops the padding", () => {
    expect(splitTagSet("MLB | NFL | NCAAFB")).toEqual(["MLB", "NFL", "NCAAFB"]);
    expect(splitTagSet("")).toEqual([]);
  });
});

describe("the real export", () => {
  const rows = parseCsv(
    readFileSync(new URL("../__fixtures__/transactions-sample.csv", import.meta.url), "utf8")
  );

  it("parses every row of the sample", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(() => rows.map(parsePikkitRow)).not.toThrow();
  });

  it("finds a market for every leg across all seven books", () => {
    // The sample is built to cover every sportsbook in the export. A leg with no market here means
    // the vocabulary has a hole, which shows up in production as an emptier breakdown, not a crash.
    const legs = rows.flatMap((r) => parsePikkitRow(r).legs);
    const unknown = legs.filter((l) => l.marketKey === null);
    expect(unknown.map((l) => l.rawText)).toEqual([]);
  });

  it("covers all seven sportsbooks", () => {
    const books = new Set(rows.map((r) => parsePikkitRow(r).sportsbook));
    expect(books).toEqual(
      new Set(["Dabble", "Underdog", "Courtside", "Betr Picks", "Novig", "Fliff", "Rebet"])
    );
  });
});
