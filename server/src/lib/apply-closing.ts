import type { ClosingReadOutcome, ParsedRow } from "@clv/shared";
import { prisma } from "./prisma";
import type { MarketType, Side, Status } from "./constants";
import { buildClosingVerdict } from "./closing";
import { evPercent, fantasyPriceFrom } from "./ev";
import { getAppSettings } from "./app-settings";

export interface ClosingReport {
  betId: string;
  /** What the read found. The current shape. */
  outcome?: ClosingReadOutcome;
  // --- legacy shape, accepted for one release so an un-rebuilt extension keeps working ---
  /** The matched row, or null when the prop was no longer on the board. */
  row?: ParsedRow | null;
  /** Whether the extension could read the board at all. */
  parseOk?: boolean;
  /** How many rows the board showed, to tell "prop delisted" from "board never loaded". */
  boardRowCount?: number;
  reason?: string | null;
}

/**
 * Bridges a report sent by an extension that has not been rebuilt yet.
 *
 * The old payload could not distinguish "this selection is not offered" from "the page never
 * loaded", which is the collapse this redesign exists to undo -- so the translation here is
 * deliberately conservative and never invents the distinction it lacks.
 */
function asOutcome(report: ClosingReport): ClosingReadOutcome {
  if (report.outcome) return report.outcome;
  if (report.row) {
    return {
      kind: "MATCHED",
      row: report.row,
      source: {
        site: "PROPPROFESSOR_SCREEN",
        url: "",
        league: report.row.sport ?? "",
        market: report.row.statMarket ?? "",
      },
    };
  }
  if (report.parseOk && (report.boardRowCount ?? 0) > 0) {
    return {
      kind: "SELECTION_ABSENT",
      source: { site: "PROPPROFESSOR_SCREEN", url: "", league: "", market: "" },
      candidateCount: report.boardRowCount ?? 0,
      sampleNames: [],
    };
  }
  return { kind: "READ_FAILED", reason: report.reason ?? "board could not be read" };
}

/**
 * Records the outcome of a closing read performed by the extension in the user's own browser.
 *
 * Never invents a result. The retry policy is the part worth being careful about: only a genuine
 * failure may burn a fetch attempt, because a pick that is merely unpriceable would otherwise
 * exhaust its budget and be written off as broken when nothing broke.
 *
 * | outcome            | status            | retry | burns an attempt |
 * |--------------------|-------------------|-------|------------------|
 * | MATCHED            | via verdict       | --    | no               |
 * | SELECTION_ABSENT   | UNAVAILABLE       | no    | no               |
 * | NO_CLOSING_MARKET  | NO_CLOSING_MARKET | no    | no               |
 * | MARKET_NOT_OFFERED | FETCH_FAILED      | yes   | yes              |
 * | READ_FAILED        | FETCH_FAILED      | yes   | yes              |
 */
export async function applyClosingReport(report: ClosingReport) {
  const bet = await prisma.bet.findUnique({ where: { id: report.betId } });
  if (!bet) return { ok: false as const, error: "not found" };

  const now = new Date();
  // Deliberately NOT clamped at zero. The read now happens *before* kickoff, so a healthy capture
  // is negative -- that is the good case, and clamping it away would make an early read look like
  // a read exactly at kickoff. Existing rows are all >= 0, so nothing is reinterpreted.
  const lagSeconds = bet.gameStartTime
    ? Math.round((now.getTime() - bet.gameStartTime.getTime()) / 1000)
    : null;

  const outcome = asOutcome(report);

  if (outcome.kind !== "MATCHED") {
    const { status, note, burnsAttempt } = describeFailure(outcome);
    const updated = await prisma.bet.update({
      where: { id: bet.id },
      data: {
        status,
        ...(burnsAttempt ? { fetchAttempts: { increment: 1 } } : {}),
        closeCapturedAt: now,
        closingCaptureLagSeconds: lagSeconds,
        lastFetchAt: now,
        lastFetchError: note,
        // Releasing the lease lets a retryable pick be served again on the next poll rather than
        // waiting out the full lease for no reason.
        leasedUntil: null,
        ...("source" in outcome
          ? { closingSourceSite: outcome.source.site, closingSourceUrl: outcome.source.url }
          : {}),
      },
    });
    return { ok: true as const, status: updated.status };
  }

  const row = outcome.row;
  const settings = await getAppSettings();
  const verdict = buildClosingVerdict(
    bet.marketType as MarketType,
    bet.side as Side | null,
    bet.takenLine,
    row,
    settings.useWeightedAverage ? settings.bookWeights : null,
    "PP_SCREEN"
  );

  await prisma.closeLine.deleteMany({ where: { betId: bet.id } });
  const updated = await prisma.bet.update({
    where: { id: bet.id },
    data: {
      status: verdict.status,
      closeRawSnapshotJson: JSON.stringify(row),
      closeCapturedAt: now,
      closingCaptureLagSeconds: lagSeconds,
      lastFetchAt: now,
      leasedUntil: null,
      closeLines: { create: verdict.closeLines },
      avgClosingLine: verdict.avgClosingLine,
      closingBookCount: verdict.closingBookCount,
      closeFairProb: row.fairProbability,
      // Payout comes from the closing read when it shows one, else the one recorded at capture.
      // The odds screen publishes no de-vigged probability of its own, so in practice this keeps
      // the capture-time number rather than inventing a closing one.
      closeEvPercent:
        row.boardEvPercent ??
        evPercent(row.fairProbability, fantasyPriceFrom(row.bookLines) ?? bet.fantasyPrice) ??
        bet.closeEvPercent,
      edge: verdict.edge,
      beatClv: verdict.beatClv,
      closingSourceSite: outcome.source.site,
      closingSourceUrl: outcome.source.url,
      closingMethod: verdict.closingSource,
      // Staleness is derived from closingCaptureLagSeconds by the UI, so it is not repeated here.
      lastFetchError: verdict.note,
    },
  });

  return { ok: true as const, status: updated.status, edge: verdict.edge, beatClv: verdict.beatClv };
}

function describeFailure(outcome: Exclude<ClosingReadOutcome, { kind: "MATCHED" }>): {
  status: Status;
  note: string;
  burnsAttempt: boolean;
} {
  switch (outcome.kind) {
    case "SELECTION_ABSENT": {
      const sample = outcome.sampleNames.length
        ? ` (saw ${outcome.sampleNames.slice(0, 4).join(", ")})`
        : "";
      return {
        status: "UNAVAILABLE",
        // Specific on purpose: "not found" was the message that made the original bug invisible.
        note:
          `${outcome.source.market} listed ${outcome.candidateCount} selections at close and this ` +
          `pick was not among them${sample}. Usually a scratch or a pulled market.`,
        burnsAttempt: false,
      };
    }
    case "NO_CLOSING_MARKET":
      return { status: "NO_CLOSING_MARKET", note: outcome.reason, burnsAttempt: false };
    case "MARKET_NOT_OFFERED":
      return {
        status: "FETCH_FAILED",
        note:
          `${outcome.source.league} ${outcome.source.market} returned nothing at close.` +
          (outcome.availableMarkets.length
            ? ` Available: ${outcome.availableMarkets.slice(0, 12).join(", ")}`
            : ""),
        burnsAttempt: true,
      };
    default:
      return { status: "FETCH_FAILED", note: outcome.reason, burnsAttempt: true };
  }
}
