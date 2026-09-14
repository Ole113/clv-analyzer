import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importRows, PikkitFileError, readPikkitCsv, type UpsertOutcome } from "../store";
import type { ParsedPikkitBet } from "../parse";

/**
 * The rule the multi-year workflow rests on: the same bet arriving twice must update, never
 * duplicate.
 *
 * Tested against an in-memory stand-in for the database rather than a real one. What can actually
 * go wrong here is in the orchestration -- a bet keyed on the wrong field, a failed row counted as
 * a success, a second import inserting instead of updating -- and none of that needs SQLite to
 * show up. The Prisma writer itself is exercised by importing the real export in the browser.
 */
function fakeStore() {
  const bets = new Map<string, ParsedPikkitBet>();
  const upsert = async (bet: ParsedPikkitBet): Promise<UpsertOutcome> => {
    const seen = bets.has(bet.externalId);
    bets.set(bet.externalId, bet);
    return seen ? "updated" : "created";
  };
  return { bets, upsert };
}

const sample = readFileSync(
  new URL("../__fixtures__/transactions-sample.csv", import.meta.url),
  "utf8"
);

describe("readPikkitCsv", () => {
  it("refuses a file that is not a Pikkit export, naming what is missing", () => {
    // One clear message about the file, rather than the same error repeated once per row.
    try {
      readPikkitCsv("date,amount\n2026-01-01,5\n");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PikkitFileError);
      expect((error as PikkitFileError).detail).toContain("bet_id");
    }
  });

  it("refuses a file with no rows", () => {
    expect(() => readPikkitCsv("bet_id,sportsbook,status,odds,amount,profit\n")).toThrow(PikkitFileError);
  });

  it("accepts the real export", () => {
    expect(readPikkitCsv(sample).length).toBeGreaterThan(0);
  });
});

describe("importRows", () => {
  it("creates on the first pass and updates on the second", () => {
    const { upsert, bets } = fakeStore();
    const rows = readPikkitCsv(sample);
    return importRows(rows, upsert).then(async (first) => {
      expect(first.created).toBe(rows.length);
      expect(first.updated).toBe(0);
      expect(first.failures).toEqual([]);

      const second = await importRows(rows, upsert);
      expect(second.created).toBe(0);
      expect(second.updated).toBe(rows.length);
      // The whole point: the dataset is the same size after importing the same file twice.
      expect(bets.size).toBe(rows.length);
    });
  });

  it("settles a bet that was still open in the previous export", async () => {
    const { upsert, bets } = fakeStore();
    const open = {
      bet_id: "same-bet",
      sportsbook: "Novig",
      type: "straight",
      status: "PLACED",
      odds: "2.5",
      closing_line: "",
      ev: "",
      amount: "10",
      profit: "0.00",
      time_placed_iso: "2026-09-13T20:02:30.848Z",
      time_settled_iso: "",
      bet_info: "Over 0.5 A Hits X @ Y",
      tags: "",
      sports: "Baseball",
      leagues: "MLB",
    };

    await importRows([open], upsert);
    expect(bets.get("same-bet")?.result).toBe("PENDING");

    const settled = { ...open, status: "SETTLED_WIN", profit: "15.00", closing_line: "2.2" };
    const tally = await importRows([settled], upsert);

    expect(tally.updated).toBe(1);
    expect(tally.created).toBe(0);
    expect(bets.size).toBe(1);
    expect(bets.get("same-bet")).toMatchObject({ result: "WIN", profit: 15, closingDecimal: 2.2 });
  });

  it("reports an unreadable row by line number and keeps importing the rest", async () => {
    const { upsert } = fakeStore();
    const rows = readPikkitCsv(sample);
    // Line 3 of the file: the header is line 1, so this is the second record.
    const broken = [...rows];
    broken[1] = { ...broken[1], status: "SETTLED_WHO_KNOWS" };

    const tally = await importRows(broken, upsert);
    expect(tally.created).toBe(rows.length - 1);
    expect(tally.failures).toHaveLength(1);
    expect(tally.failures[0].line).toBe(3);
    expect(tally.failures[0].reason).toContain("SETTLED_WHO_KNOWS");
  });
});
