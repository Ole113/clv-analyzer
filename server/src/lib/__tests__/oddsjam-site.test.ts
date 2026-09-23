import { describe, expect, it } from "vitest";
import {
  findGameEntry,
  findMarketId,
  oddsJamCandidateLabel,
  oddsJamSportSlug,
  pruneGameEntries,
  resolveOddsJamLink,
  type OddsJamGameEntry,
  type OddsJamMarketEntry,
} from "@clv/shared";

/**
 * The pure half of the OddsJam deep-link feature -- everything storage-agnostic, so it is testable
 * in Node exactly like `matching.ts`/`markets.ts` are. `extension/src/content/oddsjam-site/capture.ts`
 * and `store.ts` are the browser-side glue this is built for, and are covered by the read-only guard
 * test instead (they touch `chrome.storage`, which nothing here needs).
 */

function game(overrides: Partial<OddsJamGameEntry> = {}): OddsJamGameEntry {
  return {
    sportSlug: "nfl",
    slug: "giants-vs-rams-odds--78014-37430-26-38",
    awayTeam: "New York Giants",
    homeTeam: "Los Angeles Rams",
    kickoffIso: "2026-09-21T20:15:00-04:00",
    capturedAt: Date.parse("2026-09-20T12:00:00Z"),
    ...overrides,
  };
}

describe("oddsJamSportSlug", () => {
  it("resolves the boards' own spellings to OddsJam's URL segment", () => {
    expect(oddsJamSportSlug("NFL")).toBe("nfl");
    expect(oddsJamSportSlug("College Football")).toBe("ncaaf");
    expect(oddsJamSportSlug("ATP")).toBe("tennis");
    expect(oddsJamSportSlug("WTA")).toBe("tennis");
  });

  it("returns null for a sport OddsJam's site is not known to cover, and for no sport at all", () => {
    expect(oddsJamSportSlug("CSGO")).toBeNull();
    expect(oddsJamSportSlug(null)).toBeNull();
    expect(oddsJamSportSlug("")).toBeNull();
  });
});

describe("oddsJamCandidateLabel", () => {
  it("reorders a period-qualified market from PropProfessor's suffix to OddsJam's prefix", () => {
    expect(oddsJamCandidateLabel("Player Passing Yards - 1st Quarter")).toBe(
      "1st Quarter Player Passing Yards"
    );
    expect(oddsJamCandidateLabel("Total Points - 1st Half")).toBe("1st Half Total Points");
  });

  it("passes an unqualified market through unchanged", () => {
    expect(oddsJamCandidateLabel("Player Rushing Attempts")).toBe("Player Rushing Attempts");
    expect(oddsJamCandidateLabel("Moneyline")).toBe("Moneyline");
  });
});

describe("findMarketId", () => {
  const vocabulary: OddsJamMarketEntry[] = [
    { id: "player_rushing_attempts", label: "Player Rushing Attempts" },
    { id: "1st_quarter_player_passing_yards", label: "1st Quarter Player Passing Yards" },
    { id: "total_points", label: "Total Points" },
  ];

  it("finds the real id for a label it has actually seen", () => {
    expect(findMarketId(vocabulary, "Player Rushing Attempts")).toBe("player_rushing_attempts");
    expect(findMarketId(vocabulary, "1st Quarter Player Passing Yards")).toBe(
      "1st_quarter_player_passing_yards"
    );
  });

  it("is agnostic to a leading 'Player ' the way PropProfessor's own table is", () => {
    expect(findMarketId(vocabulary, "Rushing Attempts")).toBe("player_rushing_attempts");
  });

  it("returns null rather than a near miss for a market never captured", () => {
    expect(findMarketId(vocabulary, "Player Receiving Yards")).toBeNull();
    expect(findMarketId([], "Total Points")).toBeNull();
  });
});

describe("pruneGameEntries", () => {
  const now = Date.parse("2026-09-25T00:00:00Z");

  it("keeps an entry within a day of its own kickoff", () => {
    const recent = game({ kickoffIso: new Date(now - 2 * 60 * 60_000).toISOString() });
    expect(pruneGameEntries([recent], now)).toEqual([recent]);
  });

  it("drops an entry whose kickoff is more than a day past", () => {
    const stale = game({ kickoffIso: new Date(now - 30 * 60 * 60_000).toISOString() });
    expect(pruneGameEntries([stale], now)).toEqual([]);
  });

  it("ages a kickoff-less entry off its own capture time instead", () => {
    const noKickoff = game({ kickoffIso: null, capturedAt: now - 30 * 60 * 60_000 });
    expect(pruneGameEntries([noKickoff], now)).toEqual([]);
  });
});

describe("findGameEntry", () => {
  const entry = game();

  it("matches regardless of which side the board called 'team' and which it called 'opponent'", () => {
    expect(
      findGameEntry([entry], {
        sportSlug: "nfl",
        team: "New York Giants",
        opponent: "Los Angeles Rams",
        gameStartTimeIso: null,
      })
    ).toBe(entry);
    expect(
      findGameEntry([entry], {
        sportSlug: "nfl",
        team: "Los Angeles Rams",
        opponent: "New York Giants",
        gameStartTimeIso: null,
      })
    ).toBe(entry);
  });

  it("tolerates the same team-spelling differences the rest of the matcher already does", () => {
    expect(
      findGameEntry([entry], {
        sportSlug: "nfl",
        team: "Giants",
        opponent: "Rams",
        gameStartTimeIso: null,
      })
    ).toBe(entry);
  });

  it("never vacuously matches a row with no fixture of its own", () => {
    expect(
      findGameEntry([entry], { sportSlug: "nfl", team: null, opponent: null, gameStartTimeIso: null })
    ).toBeNull();
  });

  it("returns null for the right teams in the wrong sport, or teams it has never seen", () => {
    expect(
      findGameEntry([entry], {
        sportSlug: "nba",
        team: "New York Giants",
        opponent: "Los Angeles Rams",
        gameStartTimeIso: null,
      })
    ).toBeNull();
    expect(
      findGameEntry([entry], {
        sportSlug: "nfl",
        team: "Dallas Cowboys",
        opponent: "Philadelphia Eagles",
        gameStartTimeIso: null,
      })
    ).toBeNull();
  });

  /**
   * Two teams playing each other twice (a divisional rematch) is the one case a team pair alone
   * cannot disambiguate -- the row's own kickoff is what breaks the tie, the same problem
   * `pp-screen-source.test.ts`'s "refuses a game market it cannot pin to a fixture" test guards from
   * the opposite direction (there, no fixture at all; here, two real fixtures with the same one).
   */
  it("breaks a rematch tie by whichever kickoff the row is closest to", () => {
    const early = game({ slug: "giants-vs-rams-week3", kickoffIso: "2026-09-21T20:15:00-04:00" });
    const late = game({ slug: "giants-vs-rams-week15", kickoffIso: "2026-12-14T13:00:00-05:00" });
    const target = {
      sportSlug: "nfl",
      team: "New York Giants",
      opponent: "Los Angeles Rams",
    };
    expect(
      findGameEntry([early, late], { ...target, gameStartTimeIso: "2026-09-21T20:15:00-04:00" })
    ).toBe(early);
    expect(
      findGameEntry([early, late], { ...target, gameStartTimeIso: "2026-12-14T13:00:00-05:00" })
    ).toBe(late);
  });

  it("falls back to the most recently captured candidate when no kickoff is available to compare", () => {
    const older = game({ slug: "older", capturedAt: 1000, kickoffIso: null });
    const newer = game({ slug: "newer", capturedAt: 2000, kickoffIso: null });
    expect(
      findGameEntry([older, newer], {
        sportSlug: "nfl",
        team: "New York Giants",
        opponent: "Los Angeles Rams",
        gameStartTimeIso: null,
      })
    ).toBe(newer);
  });
});

describe("resolveOddsJamLink", () => {
  const entry = game();
  const nflVocabulary: OddsJamMarketEntry[] = [
    { id: "player_rushing_attempts", label: "Player Rushing Attempts" },
    { id: "1st_quarter_player_passing_yards", label: "1st Quarter Player Passing Yards" },
    { id: "total_points", label: "Total Points" },
  ];

  it("builds the exact game+market URL when both are known", () => {
    const link = resolveOddsJamLink(
      {
        sport: "NFL",
        statMarket: "Rushing Attempts",
        marketType: "PLAYER_PROP",
        team: "New York Giants",
        opponent: "Los Angeles Rams",
        gameStartTimeIso: null,
      },
      [entry],
      { nfl: nflVocabulary }
    );
    expect(link).toEqual({
      url: "https://oddsjam.com/game/giants-vs-rams-odds--78014-37430-26-38?market=player_rushing_attempts",
      precision: "exact",
    });
  });

  it("reuses PropProfessor's period handling to find a period-qualified market", () => {
    const link = resolveOddsJamLink(
      {
        sport: "NFL",
        statMarket: "1st Quarter Passing Yards",
        marketType: "PLAYER_PROP",
        team: "New York Giants",
        opponent: "Los Angeles Rams",
        gameStartTimeIso: null,
      },
      [entry],
      { nfl: nflVocabulary }
    );
    expect(link).toEqual({
      url: "https://oddsjam.com/game/giants-vs-rams-odds--78014-37430-26-38?market=1st_quarter_player_passing_yards",
      precision: "exact",
    });
  });

  it("reuses the game-total default the same way resolveClosingMarket does", () => {
    const link = resolveOddsJamLink(
      {
        sport: "NFL",
        statMarket: "Game Total",
        marketType: "GAME_TOTAL",
        team: "New York Giants",
        opponent: "Los Angeles Rams",
        gameStartTimeIso: null,
      },
      [entry],
      { nfl: nflVocabulary }
    );
    expect(link).toEqual({
      url: "https://oddsjam.com/game/giants-vs-rams-odds--78014-37430-26-38?market=total_points",
      precision: "exact",
    });
  });

  it("reports the game alone when the market has not been captured", () => {
    const link = resolveOddsJamLink(
      {
        sport: "NFL",
        statMarket: "Receiving Yards",
        marketType: "PLAYER_PROP",
        team: "New York Giants",
        opponent: "Los Angeles Rams",
        gameStartTimeIso: null,
      },
      [entry],
      { nfl: nflVocabulary }
    );
    expect(link).toEqual({
      url: "https://oddsjam.com/game/giants-vs-rams-odds--78014-37430-26-38",
      precision: "game",
    });
  });

  it("reports the sport alone when the game has not been captured", () => {
    const link = resolveOddsJamLink(
      {
        sport: "NFL",
        statMarket: "Rushing Attempts",
        marketType: "PLAYER_PROP",
        team: "Dallas Cowboys",
        opponent: "Philadelphia Eagles",
        gameStartTimeIso: null,
      },
      [entry],
      { nfl: nflVocabulary }
    );
    expect(link).toEqual({ url: "https://oddsjam.com/nfl/odds", precision: "sport" });
  });

  it("returns null for a sport OddsJam's site is not known to cover", () => {
    expect(
      resolveOddsJamLink(
        {
          sport: "CSGO",
          statMarket: "Maps Won",
          marketType: "PLAYER_PROP",
          team: null,
          opponent: null,
          gameStartTimeIso: null,
        },
        [],
        {}
      )
    ).toBeNull();
  });

  it("never fabricates a market id for a DFS-only market -- reports the game alone", () => {
    const link = resolveOddsJamLink(
      {
        sport: "NFL",
        statMarket: "Fantasy Score (PrizePicks)",
        marketType: "PLAYER_PROP",
        team: "New York Giants",
        opponent: "Los Angeles Rams",
        gameStartTimeIso: null,
      },
      [entry],
      { nfl: nflVocabulary }
    );
    expect(link).toEqual({
      url: "https://oddsjam.com/game/giants-vs-rams-odds--78014-37430-26-38",
      precision: "game",
    });
  });
});
