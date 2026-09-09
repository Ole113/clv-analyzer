import type { ParsedRow } from "@clv/shared";
import { prisma } from "./prisma";
import type { MarketType, Side } from "./constants";
import { buildClosingVerdict } from "./closing";
import { evPercent, fantasyPriceFrom } from "./ev";

export interface ClosingReport {
  betId: string;
  /** The matched row, or null when the prop was no longer on the board. */
  row: ParsedRow | null;
  /** Whether the extension could read the board at all. */
  parseOk: boolean;
  /** How many rows the board showed, to tell "prop delisted" from "board never loaded". */
  boardRowCount: number;
  reason?: string | null;
}

/**
 * Records the outcome of a closing read performed by the extension in the user's own browser.
 *
 * Never invents a result: a prop that is gone from a healthy board is UNAVAILABLE, a board that
 * could not be read at all stays FETCH_FAILED and retryable.
 */
export async function applyClosingReport(report: ClosingReport) {
  const bet = await prisma.bet.findUnique({ where: { id: report.betId } });
  if (!bet) return { ok: false as const, error: "not found" };

  const now = new Date();
  const lagSeconds = bet.gameStartTime
    ? Math.max(0, Math.round((now.getTime() - bet.gameStartTime.getTime()) / 1000))
    : null;

  if (!report.row) {
    const kickoffPassed =
      bet.gameStartTime !== null && now.getTime() > bet.gameStartTime.getTime() + 60_000;
    // A healthy board that simply no longer lists the prop means there is nothing left to measure.
    // A board we could not read means the session or the parser broke -- keep that retryable.
    const unavailable = report.parseOk && report.boardRowCount > 0 && kickoffPassed;
    const updated = await prisma.bet.update({
      where: { id: bet.id },
      data: {
        status: unavailable ? "UNAVAILABLE" : "FETCH_FAILED",
        // Only a genuine failure burns a retry, so a pick that simply is not due yet or reads
        // cleanly never counts against the budget.
        ...(unavailable ? {} : { fetchAttempts: { increment: 1 } }),
        closeCapturedAt: now,
        closingCaptureLagSeconds: lagSeconds,
        lastFetchAt: now,
        lastFetchError: unavailable
          ? `Prop was no longer listed at close (board showed ${report.boardRowCount} rows)`
          : `Could not read the board: parseOk=${report.parseOk} rows=${report.boardRowCount}` +
            (report.reason ? ` ${report.reason}` : ""),
      },
    });
    return { ok: true as const, status: updated.status };
  }

  const verdict = buildClosingVerdict(
    bet.marketType as MarketType,
    bet.side as Side | null,
    bet.takenLine,
    report.row
  );

  await prisma.closeLine.deleteMany({ where: { betId: bet.id } });
  const updated = await prisma.bet.update({
    where: { id: bet.id },
    data: {
      status: verdict.status,
      closeRawSnapshotJson: JSON.stringify(report.row),
      closeCapturedAt: now,
      closingCaptureLagSeconds: lagSeconds,
      lastFetchAt: now,
      closeLines: { create: verdict.closeLines },
      avgClosingLine: verdict.avgClosingLine,
      closingBookCount: verdict.closingBookCount,
      closeFairProb: report.row.fairProbability,
      // Payout comes from the closing board when shown, else the one recorded at capture. Boards
      // that state an EV% directly (rebet/fliff) are again taken at their word.
      closeEvPercent:
        report.row.boardEvPercent ??
        evPercent(
          report.row.fairProbability,
          fantasyPriceFrom(report.row.bookLines) ?? bet.fantasyPrice
        ),
      edge: verdict.edge,
      beatClv: verdict.beatClv,
      // Staleness is derived from closingCaptureLagSeconds by the UI, so it is not repeated here.
      lastFetchError: verdict.note,
    },
  });

  return { ok: true as const, status: updated.status, edge: verdict.edge, beatClv: verdict.beatClv };
}
