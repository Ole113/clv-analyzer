import { prisma } from "../prisma";
import { parseCsv } from "./csv";
import { parsePikkitRow, PikkitRowError, type ParsedPikkitBet } from "./parse";

/**
 * Reading an export into the database.
 *
 * Kept out of `import.ts` because that file is `"use server"` and may only export async functions,
 * which makes everything in it unreachable from a test -- and this is where the rule the whole
 * multi-year workflow depends on lives: the same bet arriving a second time must update, never
 * duplicate. `importRows` therefore takes its writer as an argument, so the tallying, the
 * per-row error handling and the upsert-not-insert contract can be checked without a database.
 */

export type UpsertOutcome = "created" | "updated";

/** One row that could not be read, reported by line number rather than swallowed. */
export interface ImportFailure {
  /** 1-based line in the file, counting the header, so it matches what a text editor shows. */
  line: number;
  reason: string;
}

export interface ImportTally {
  created: number;
  updated: number;
  failures: ImportFailure[];
}

/**
 * What the import screen is told.
 *
 * Declared here rather than beside the server action that returns it: a `"use server"` module's
 * every export is compiled into a callable action, and a re-exported type is not one -- the build
 * fails with "Export ImportFailure doesn't exist in target module". So the action file exports
 * functions only, and the shapes live next to the logic that fills them.
 */
export interface PikkitImportResult extends ImportTally {
  ok: boolean;
  message: string;
  detail: string | null;
}

/** Guards against a mis-picked file turning into a very long transaction. */
export const MAX_ROWS = 50_000;

/** The columns an export must have for the import to mean anything. */
export const REQUIRED_COLUMNS = ["bet_id", "sportsbook", "status", "odds", "amount", "profit"];

export class PikkitFileError extends Error {
  constructor(
    message: string,
    readonly detail: string | null = null
  ) {
    super(message);
  }
}

/**
 * Parse the file and check it is the right kind of file.
 *
 * The header is checked up front rather than row by row: a CSV that is not a Pikkit export would
 * otherwise fail on every one of its rows individually and report a wall of identical errors
 * instead of the one thing that is actually wrong.
 */
export function readPikkitCsv(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new PikkitFileError("That file has no rows", "Only a header, or an empty file.");
  }
  if (rows.length > MAX_ROWS) {
    throw new PikkitFileError(
      `That file has ${rows.length} rows`,
      `The import handles up to ${MAX_ROWS} at a time.`
    );
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !(c in rows[0]));
  if (missing.length > 0) {
    throw new PikkitFileError(
      "That does not look like a Pikkit export",
      `Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`
    );
  }
  return rows;
}

export async function upsertPikkitBet(bet: ParsedPikkitBet): Promise<UpsertOutcome> {
  const { legs, externalId, ...fields } = bet;
  const existing = await prisma.pikkitBet.findUnique({
    where: { externalId },
    select: { id: true },
  });

  const legRows = legs.map((leg) => ({
    legIndex: leg.legIndex,
    rawText: leg.rawText,
    side: leg.side,
    line: leg.line,
    player: leg.player,
    market: leg.market,
    marketKey: leg.marketKey,
    matchup: leg.matchup,
  }));

  if (!existing) {
    await prisma.pikkitBet.create({
      data: { externalId, ...fields, legs: { create: legRows } },
    });
    return "created";
  }

  // Legs are replaced wholesale rather than diffed. They are derived data -- re-parsed from
  // `bet_info` on every import -- so a leg has no identity of its own worth preserving, and
  // replacing them is what lets an improvement to the leg parser reach bets already imported.
  await prisma.$transaction([
    prisma.pikkitLeg.deleteMany({ where: { betId: existing.id } }),
    prisma.pikkitBet.update({
      where: { id: existing.id },
      data: { ...fields, legs: { create: legRows } },
    }),
  ]);
  return "updated";
}

export async function importRows(
  rows: Record<string, string>[],
  upsert: (bet: ParsedPikkitBet) => Promise<UpsertOutcome> = upsertPikkitBet
): Promise<ImportTally> {
  const tally: ImportTally = { created: 0, updated: 0, failures: [] };

  for (const [i, row] of rows.entries()) {
    try {
      const outcome = await upsert(parsePikkitRow(row));
      if (outcome === "created") tally.created += 1;
      else tally.updated += 1;
    } catch (error) {
      // One unreadable row must not abandon the other few thousand, so failures are collected and
      // reported rather than thrown -- but they are never counted as successes either.
      tally.failures.push({
        line: i + 2,
        reason: error instanceof PikkitRowError ? error.message : String(error),
      });
    }
  }

  return tally;
}
