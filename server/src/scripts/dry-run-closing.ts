import {
  findMatchingRow,
  normalizeScreenMarket,
  planScreenRead,
  type ClosingWorkItem,
} from "@clv/shared";
import { prisma } from "../lib/prisma";
import { buildClosingVerdict } from "../lib/closing";
import type { MarketType, Side } from "../lib/constants";

/**
 * Prints the closing verdict each open pick *would* get, without writing anything.
 *
 * The point is to compare the new screen-based reading against real picks before trusting it, and
 * to see the whole path work on live data rather than on saved fixtures. Reads only PropProfessor;
 * it never contacts OddsJam, whatever site a pick was captured on.
 *
 *   npx tsx src/scripts/dry-run-closing.ts
 */
async function main() {
  const bets = await prisma.bet.findMany({
    where: { status: { notIn: ["CLOSED", "LIVE_NO_CLV"] } },
    orderBy: { gameStartTime: "asc" },
  });

  console.log(`${bets.length} open picks\n`);

  for (const bet of bets) {
    const item: ClosingWorkItem = {
      id: bet.id,
      site: bet.site as ClosingWorkItem["site"],
      fantasyBook: bet.fantasyBook,
      marketType: bet.marketType as MarketType,
      player: bet.player,
      subjectTeam: bet.subjectTeam,
      matchup: bet.matchup,
      statMarket: bet.statMarket,
      side: bet.side as Side | null,
      externalPropId: bet.externalPropId,
      pageUrl: bet.pageUrl,
      gameStartTime: bet.gameStartTime?.toISOString() ?? null,
      sport: bet.sport,
      takenLine: bet.takenLine,
    };

    const label = `${bet.player ?? bet.subjectTeam} ${bet.side ?? ""} ${bet.takenLine} (${bet.sport} ${bet.statMarket})`;
    const plan = planScreenRead(item);
    if ("kind" in plan) {
      console.log(`✗ ${label}\n    ${plan.kind}: ${plan.reason}\n`);
      continue;
    }

    let parsed;
    try {
      const response = await fetch(plan.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan.body),
      });
      if (!response.ok) {
        console.log(`✗ ${label}\n    screen responded ${response.status}\n`);
        continue;
      }
      parsed = normalizeScreenMarket(await response.json(), plan);
    } catch (error) {
      console.log(`✗ ${label}\n    ${error instanceof Error ? error.message : "fetch failed"}\n`);
      continue;
    }

    if (!parsed.ok) {
      console.log(`✗ ${label}\n    ${parsed.reason}\n`);
      continue;
    }

    const row = findMatchingRow(parsed.rows, {
      marketType: item.marketType,
      player: item.player,
      subjectTeam: item.subjectTeam,
      matchup: item.matchup,
      statMarket: item.statMarket,
      side: item.side,
      externalPropId: item.externalPropId,
    });

    if (!row) {
      const names = [...new Set(parsed.rows.map((r) => r.player ?? r.subjectTeam))].slice(0, 5);
      console.log(
        `~ ${label}\n    UNAVAILABLE: ${plan.body.market} listed ${parsed.rows.length} selections; ` +
          `not among them (saw ${names.join(", ")})\n`
      );
      continue;
    }

    const verdict = buildClosingVerdict(
      item.marketType,
      item.side,
      bet.takenLine,
      row,
      null,
      "PP_SCREEN"
    );
    const included = verdict.closeLines.filter((l) => l.includedInAverage);
    console.log(
      `✓ ${label}\n` +
        `    close ${verdict.avgClosingLine} over ${verdict.closingBookCount} books  ` +
        `edge ${verdict.edge}  ${verdict.beatClv ? "BEAT CLV" : "missed"}\n` +
        `    included: ${included.map((l) => `${l.bookKey} ${l.line}`).join(", ")}\n` +
        (verdict.note ? `    note: ${verdict.note}\n` : "")
    );
  }

  await prisma.$disconnect();
}

void main();
