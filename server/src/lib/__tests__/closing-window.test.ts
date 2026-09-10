import { describe, expect, it } from "vitest";
import { config, scheduledFetchAtFor, closingWindowEndsAt } from "../constants";
import { findLineOutliers } from "../clv";

const minutes = (n: number) => n * 60_000;

describe("closing read window", () => {
  const kickoff = new Date("2026-09-12T16:00:00.000Z");

  it("opens before kickoff, not after it", () => {
    // The old schedule fired once at kickoff + 2 min. A started game is no longer listed on the
    // odds screen at all, so that read found nothing 100% of the time.
    const now = new Date(kickoff.getTime() - minutes(60));
    const opens = scheduledFetchAtFor(kickoff, now);
    expect(opens.getTime()).toBe(kickoff.getTime() - minutes(config.closingReadOpensMinutesBefore));
    expect(opens.getTime()).toBeLessThan(kickoff.getTime());
  });

  it("serves a pick ticked inside its own window immediately", () => {
    // Ticked 4 minutes before kickoff: the window is already open, so scheduling it at T-8 would
    // put it in the past and it would sit until the next poll for no reason.
    const now = new Date(kickoff.getTime() - minutes(4));
    expect(scheduledFetchAtFor(kickoff, now).getTime()).toBe(now.getTime());
  });

  it("stops serving once the game is far enough past kickoff to be gone from the screen", () => {
    const ends = closingWindowEndsAt(kickoff);
    expect(ends.getTime()).toBe(kickoff.getTime() + minutes(config.closingReadClosesMinutesAfter));
    expect(new Date(kickoff.getTime() + minutes(2)) <= ends).toBe(true);
    expect(new Date(kickoff.getTime() + minutes(30)) <= ends).toBe(false);
  });
});

describe("line outlier rejection", () => {
  const line = (bookKey: string, value: number) => ({
    bookKey,
    line: value,
    includedInAverage: true,
  });

  it("drops the book that is far from the field", () => {
    // The real case, from a captured market: five books cluster at 20.5-24.5 and Fanatics sits at
    // 49.5. Including it moves the close from 22.5 to 27.0 and flips the verdict on a 24.5 pick.
    const lines = [
      line("thescore", 24.5),
      line("hardrock", 21.5),
      line("fanatics", 49.5),
      line("rebet", 20.5),
      line("draftkings", 24.5),
      line("fliff", 21.5),
    ];
    expect([...findLineOutliers(lines)]).toEqual(["fanatics"]);
  });

  it("leaves ordinary disagreement alone when the field is tight", () => {
    // MAD collapses to 0 here, so without a floor on the threshold the 24.5 would be rejected.
    const lines = [
      line("a", 21.5),
      line("b", 21.5),
      line("c", 21.5),
      line("d", 24.5),
    ];
    expect(findLineOutliers(lines).size).toBe(0);
  });

  it("acts on three books but not on two", () => {
    // Three is the smallest field where one number can be the odd one out.
    expect([...findLineOutliers([line("a", 21.5), line("b", 21.5), line("c", 49.5)])]).toEqual([
      "c",
    ]);
    // With two there is nothing that could be called a consensus.
    expect(findLineOutliers([line("a", 21.5), line("b", 49.5)]).size).toBe(0);
  });

  it("keeps everything when there is no majority to be an outlier from", () => {
    const lines = [line("a", 10), line("b", 10), line("c", 90), line("d", 90)];
    expect(findLineOutliers(lines).size).toBe(0);
  });

  it("catches a stray exchange price on a moneyline", () => {
    // The case that motivated this: anyone can leave an order resting on an exchange, so Kalshi
    // sits at -1000 while every sportsbook has the same side at about -150.
    const lines = [
      line("fanduel", -150),
      line("draftkings", -155),
      line("betmgm", -145),
      line("caesars", -150),
      line("kalshi", -1000),
    ];
    expect([...findLineOutliers(lines, "MONEYLINE")]).toEqual(["kalshi"]);
  });

  it("does not mistake the pick'em line for a disagreement", () => {
    // -105 and +105 are almost the same bet but sit 210 apart in American odds, so a test that
    // did arithmetic on the raw numbers would call a perfectly normal field wildly inconsistent.
    const lines = [
      line("fanduel", -105),
      line("draftkings", 105),
      line("betmgm", -102),
      line("caesars", 101),
      line("novig", 100),
    ];
    expect(findLineOutliers(lines, "MONEYLINE").size).toBe(0);
  });

  it("lets a heavy favourite be a heavy favourite", () => {
    // -1000 is only suspicious relative to the field. When the field agrees, it is just a big
    // favourite and nothing should be dropped.
    const lines = [
      line("fanduel", -1000),
      line("draftkings", -950),
      line("betmgm", -1100),
      line("kalshi", -980),
    ];
    expect(findLineOutliers(lines, "MONEYLINE").size).toBe(0);
  });

  it("does not let exchanges define the consensus they are judged against", () => {
    // Three sportsbooks agree at 21.5; two exchanges are both far off. Because exchange prices are
    // set by whoever has an order up, two of them agreeing is not evidence the market moved --
    // they must not drag the median toward themselves.
    const lines = [
      line("fanduel", 21.5),
      line("draftkings", 21.5),
      line("betmgm", 22),
      line("novig", 40.5),
      line("polymarket", 41),
    ];
    expect([...findLineOutliers(lines)].sort()).toEqual(["novig", "polymarket"]);
  });

  it("holds an exchange to a tighter tolerance than a sportsbook", () => {
    const field = [line("fanduel", 21.5), line("draftkings", 22), line("betmgm", 21.5), line("caesars", 22)];
    // Same number, different venue: tolerated from a book, rejected from an exchange.
    expect(findLineOutliers([...field, line("bovada", 26.5)]).size).toBe(0);
    expect([...findLineOutliers([...field, line("kalshi", 26.5)])]).toEqual(["kalshi"]);
  });

  it("ignores books already excluded for not being sportsbooks", () => {
    const lines = [
      line("thescore", 24.5),
      line("hardrock", 21.5),
      line("rebet", 20.5),
      line("draftkings", 24.5),
      { bookKey: "prizepicks", line: 90, includedInAverage: false },
    ];
    expect(findLineOutliers(lines).size).toBe(0);
  });
});
