/**
 * Grades historical picks in one pass.
 *
 *   npx tsx src/scripts/backfill-grades.ts                      # dry run: shows what it would do
 *   npx tsx src/scripts/backfill-grades.ts --apply
 *   npx tsx src/scripts/backfill-grades.ts --apply --sport=NFL
 *   npx tsx src/scripts/backfill-grades.ts --apply --force      # re-grade already-graded picks
 *
 * Dry run is the default on purpose: a bulk grade is exactly where a bad stat mapping does the
 * most damage, and one extra command is cheap insurance.
 *
 * It calls the same gradeBet() the live grader uses, so backfilled and live grades cannot diverge.
 */
import { PrismaClient } from "@prisma/client";
import { gradeBet } from "../lib/grading/grader";
import { resolveMapping } from "../lib/grading/stat-map";

const prisma = new PrismaClient();

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const apply = has("apply");
  const force = has("force");
  const sport = arg("sport");
  const sleepMs = Number(arg("sleep") ?? 300);

  const bets = await prisma.bet.findMany({
    where: {
      gameStartTime: { not: null, lt: new Date(Date.now() - 3 * 3600_000) },
      ...(sport ? { sport } : {}),
      ...(force ? {} : { gradeResult: { in: ["GRADE_FAILED"] } }),
    },
    orderBy: { gameStartTime: "asc" },
  });

  // Prisma cannot express "null OR in(...)" in one filter cleanly, so ungraded picks are fetched
  // separately and merged.
  const ungraded = force
    ? []
    : await prisma.bet.findMany({
        where: {
          gameStartTime: { not: null, lt: new Date(Date.now() - 3 * 3600_000) },
          ...(sport ? { sport } : {}),
          gradeResult: null,
        },
        orderBy: { gameStartTime: "asc" },
      });

  const targets = [...bets, ...ungraded];
  console.log(`${targets.length} pick(s) eligible${sport ? ` for ${sport}` : ""}.`);

  if (!apply) {
    for (const bet of targets) {
      const { mapping, reason } = resolveMapping(bet.sport, bet.statMarket);
      console.log(
        `  ${bet.gameStartTime?.toISOString().slice(0, 10)}  ${bet.sport ?? "?"}  ${bet.player} ` +
          `${bet.side} ${bet.takenLine} ${bet.statMarket} -> ${mapping ? `would grade via ${mapping.source}` : `ungradeable: ${reason}`}`
      );
    }
    console.log("\nDry run. Re-run with --apply to actually grade these.");
    return;
  }

  const tally: Record<string, number> = {};
  for (const bet of targets) {
    const outcome = await gradeBet(bet.id);
    tally[outcome.result] = (tally[outcome.result] ?? 0) + 1;
    console.log(`  ${bet.player} ${bet.side} ${bet.takenLine} -> ${outcome.result}${outcome.reason ? ` (${outcome.reason.slice(0, 90)})` : ""}`);
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  console.log("\nSummary:");
  for (const [result, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${result}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
