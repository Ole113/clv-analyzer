import { prisma } from "../prisma";
import { getFinalScores } from "./sources/espn";
import { matchesTeam, teamVariants } from "./team-names";
import {
  actualForTotal,
  marginForSpread,
  settleGameMarket,
  type SideScore,
} from "./game-markets";
import { config, type Side } from "../constants";
import { resolveMapping } from "./stat-map";
import { settle } from "./grade";
import { espnSource } from "./sources/espn";
import { mlbSource } from "./sources/mlb";
import type { GradeSubject, StatsSource } from "./sources/types";

/**
 * Settles one pick against the real box score.
 *
 * Two failure kinds are kept distinct, because conflating them either hides a fixable gap or
 * retries something that will never succeed:
 *  - **Terminal** (unmapped market, unsupported sport) -> UNGRADEABLE immediately, with the reason.
 *    No retries; it will never resolve itself, and the pick stays available for manual grading.
 *  - **Retryable** (game not final yet, box score not posted, source unreachable) -> left ungraded
 *    with the reason recorded, retried until the attempt cap, then parked as UNGRADEABLE.
 *
 * It never falls back to a guess: an unmatched or ambiguous player returns a reason instead of a
 * value, because a confidently wrong grade is worse than no grade.
 */
export async function gradeBet(betId: string): Promise<{ result: string; reason?: string }> {
  const bet = await prisma.bet.findUnique({ where: { id: betId } });
  if (!bet) return { result: "MISSING" };

  const subject: GradeSubject = {
    sport: bet.sport,
    player: bet.player,
    team: bet.team,
    opponent: bet.opponent,
    matchup: bet.matchup,
    gameStartTime: bet.gameStartTime,
    externalGameId: bet.externalGameId,
  };

  const markVoid = async (reason: string) => {
    await prisma.bet.update({
      where: { id: betId },
      data: {
        gradeResult: "VOID",
        gradeReason: reason,
        gradedAt: new Date(),
        lastGradeAt: new Date(),
        gradeAttempts: bet.gradeAttempts + 1,
      },
    });
    return { result: "VOID", reason };
  };

  const markTerminal = async (reason: string) => {
    await prisma.bet.update({
      where: { id: betId },
      data: {
        gradeResult: "UNGRADEABLE",
        gradeReason: reason,
        gradedAt: new Date(),
        lastGradeAt: new Date(),
        gradeSource: null,
      },
    });
    return { result: "UNGRADEABLE", reason };
  };

  const markRetryable = async (reason: string) => {
    const attempts = bet.gradeAttempts + 1;
    const exhausted = attempts >= config.maxGradeAttempts;
    await prisma.bet.update({
      where: { id: betId },
      data: {
        gradeAttempts: attempts,
        lastGradeAt: new Date(),
        gradeReason: exhausted ? `Gave up after ${attempts} attempts. ${reason}` : reason,
        // A repeated failure is a problem to look at, not an inherent limitation of the market,
        // so it lands in GRADE_FAILED rather than being filed alongside CS2 and tennis.
        ...(exhausted ? { gradeResult: "GRADE_FAILED", gradedAt: new Date() } : {}),
      },
    });
    return { result: exhausted ? "GRADE_FAILED" : "RETRY", reason };
  };

  // --- game markets (spreads, totals) --------------------------------------
  // These carry no player, so they are settled from the final scoreboard rather than a box score.
  if (bet.marketType === "SPREAD" || bet.marketType === "GAME_TOTAL") {
    const found = await espnSource.findGame(subject);
    if ("reason" in found) return markRetryable(found.reason);

    if (found.game.externalGameId !== bet.externalGameId) {
      await prisma.bet.update({
        where: { id: betId },
        data: { externalGameId: found.game.externalGameId },
      });
    }
    if (found.game.abandoned) {
      return markVoid(`Game was postponed, suspended or cancelled (${found.game.description}).`);
    }
    if (!found.game.isFinal) {
      return markRetryable(`Game is not final yet (${found.game.description}).`);
    }

    const scored = await getFinalScores(subject, found.game.externalGameId);
    if ("reason" in scored) return markRetryable(scored.reason);

    const sides: SideScore[] = scored.scores.map((s) => ({
      variants: teamVariants(s.team),
      score: s.score,
      label: s.team.displayName ?? s.team.name ?? "team",
    }));

    let value: number | null;
    if (bet.marketType === "SPREAD") {
      if (!bet.subjectTeam) return markTerminal("This spread has no team recorded, so it cannot be settled.");
      value = marginForSpread(sides, bet.subjectTeam, matchesTeam);
      if (value === null) {
        return markRetryable(
          `Could not tell which side "${bet.subjectTeam}" is in ${found.game.description}.`
        );
      }
    } else {
      value = actualForTotal(sides);
    }

    const result = settleGameMarket(
      bet.marketType as "SPREAD" | "GAME_TOTAL",
      bet.side as Side | null,
      bet.takenLine,
      value
    );
    await prisma.bet.update({
      where: { id: betId },
      data: {
        gradeResult: result,
        actualValue: value,
        gradedAt: new Date(),
        lastGradeAt: new Date(),
        gradeSource: "espn",
        gradeReason: null,
        gradeAttempts: bet.gradeAttempts + 1,
        gradeRawJson: JSON.stringify({
          matchedName: bet.subjectTeam ?? bet.statMarket,
          game: found.game.description,
          webUrl: found.game.webUrl,
          market: bet.statMarket,
          finalScores: sides.map((s) => `${s.label} ${s.score}`).join(" - "),
        }),
      },
    });
    return { result };
  }

  if (!bet.player) {
    return markTerminal("This pick has no player recorded, so no box score can settle it.");
  }

  const { mapping, reason: mappingReason } = resolveMapping(bet.sport, bet.statMarket);
  if (!mapping) return markTerminal(mappingReason ?? "No stat mapping for this market.");

  const source: StatsSource = mapping.source === "mlb" ? mlbSource : espnSource;

  const found = await source.findGame(subject);
  if ("reason" in found) return markRetryable(found.reason);

  if (found.game.externalGameId !== bet.externalGameId) {
    await prisma.bet.update({
      where: { id: betId },
      data: { externalGameId: found.game.externalGameId },
    });
  }

  // A postponed or cancelled game will never produce a stat line, so retrying it forever until
  // the cap just delays an answer we already have.
  if (found.game.abandoned) {
    return markVoid(`Game was postponed, suspended or cancelled (${found.game.description}).`);
  }

  // Grading an unfinished game would settle against a partial stat line.
  if (!found.game.isFinal) {
    return markRetryable(`Game is not final yet (${found.game.description}).`);
  }

  const value = await source.getPlayerValue(found.game.externalGameId, subject, mapping);
  if ("reason" in value) return markRetryable(value.reason);

  // Dressed but did not appear -> there is no result to settle against, so the pick is void
  // rather than a zero that would auto-win every UNDER.
  if ("didNotPlay" in value) {
    return markVoid(`${value.matchedName} did not play in ${found.game.description}.`);
  }

  const result = settle(bet.side as Side, bet.takenLine, value.value);
  await prisma.bet.update({
    where: { id: betId },
    data: {
      gradeResult: result,
      actualValue: value.value,
      gradedAt: new Date(),
      lastGradeAt: new Date(),
      gradeSource: source.key,
      gradeReason: null,
      gradeAttempts: bet.gradeAttempts + 1,
      // Provenance: the public box score this grade came from, so it can be checked in one click.
      gradeRawJson: JSON.stringify({
        matchedName: value.matchedName,
        game: found.game.description,
        webUrl: found.game.webUrl,
        market: bet.statMarket,
      }),
    },
  });
  return { result };
}

/** Records a hand-entered result for a pick no source can settle. */
export async function gradeManually(betId: string, actualValue: number) {
  const bet = await prisma.bet.findUnique({ where: { id: betId } });
  if (!bet) return null;
  const result = settle(bet.side as Side, bet.takenLine, actualValue);
  return prisma.bet.update({
    where: { id: betId },
    data: {
      gradeResult: result,
      actualValue,
      gradedAt: new Date(),
      lastGradeAt: new Date(),
      gradeSource: "manual",
      gradeReason: null,
    },
  });
}

let running = false;

/**
 * Grades everything that has come due.
 *
 * Unlike the closing-line read, this needs no browser and no login, so the server does it itself.
 * All scheduling state lives in SQLite, so a restart simply picks up whatever is due.
 */
export async function runDueGrades(limit = 25): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const due = await prisma.bet.findMany({
      where: {
        gradeResult: null,
        gradeScheduledAt: { not: null, lte: new Date() },
        gradeAttempts: { lt: config.maxGradeAttempts },
      },
      orderBy: { gradeScheduledAt: "asc" },
      take: limit,
      select: { id: true },
    });

    let graded = 0;
    for (const bet of due) {
      try {
        await gradeBet(bet.id);
        graded++;
        // Sequential with a pause: these are free, undocumented endpoints being used politely.
        await new Promise((r) => setTimeout(r, 400));
      } catch (error) {
        console.error(`[grader] failed on ${bet.id}:`, error);
      }
    }
    return graded;
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startGrader(): void {
  if (timer) return;
  const intervalMs = Math.max(1, config.gradePollMinutes) * 60_000;
  console.log(
    `[grader] started; checking for picks due to grade every ${config.gradePollMinutes}m ` +
      `(first attempt ${config.gradeDelayHours}h after kickoff)`
  );
  timer = setInterval(() => {
    runDueGrades().catch((error) => console.error("[grader] tick failed:", error));
  }, intervalMs);
  runDueGrades().catch((error) => console.error("[grader] initial tick failed:", error));
}
