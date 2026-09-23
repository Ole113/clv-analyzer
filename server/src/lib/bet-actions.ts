"use server";

import { revalidatePath } from "next/cache";
import { type ClosingWorkItem } from "@clv/shared";
import { prisma } from "./prisma";
import type { ActionResult } from "@/components/action-button";
import { previewNow, type OddsPreview, type OddsSource } from "./odds-preview";
import { planOddsApiRead } from "@clv/shared";

/**
 * Quick actions for the `/bets` list's right-click menu. A file marked `"use server"` at the top
 * can be imported straight into a client component -- `bets-table.tsx` calls these directly rather
 * than threading them down from the page as props, the same way `action-button.tsx`'s callers do
 * for a single action, just without a Server Component in between to define the closure.
 *
 * Mirrors the equivalent actions already defined inline on `/bets/[id]`, minus the parts that only
 * make sense from a detail page already showing one bet (deleteBet there redirects home; this one
 * just revalidates the list it's already on).
 */

export async function voidBetQuick(id: string): Promise<ActionResult> {
  await prisma.bet.update({
    where: { id },
    data: {
      gradeResult: "VOID",
      actualValue: null,
      gradedAt: new Date(),
      gradeSource: "manual",
      gradeReason: "Voided by hand",
    },
  });
  revalidatePath("/bets");
  revalidatePath(`/bets/${id}`);
  return { message: "Marked void" };
}

export async function deleteBetQuick(id: string): Promise<ActionResult> {
  await prisma.bet.delete({ where: { id } });
  revalidatePath("/bets");
  return { message: "Pick deleted" };
}

/**
 * Answers the Odds modal, from The Odds API.
 *
 * `planOddsApiRead` is checked here, synchronously, before anything is attempted: a market with no
 * Odds API equivalent at all will never succeed no matter how many times it is retried, so the
 * modal should say so at once.
 *
 * Everything past that check is handled by `previewNow`, which reads The Odds API and returns the
 * answer inside this one call -- always a `result`, never a queue: this used to also try a direct
 * server-side read of PropProfessor's odds screen, falling back to the extension when the server
 * had no session token, but that automation is what got the PropProfessor account banned
 * (2026-09), so The Odds API is the only source left.
 */
export async function requestOddsPreview(
  id: string,
  options: { refresh?: boolean; source?: OddsSource } = {}
): Promise<{ ok: true; mode: "result"; preview: OddsPreview } | { ok: false; reason: string }> {
  const bet = await prisma.bet.findUnique({ where: { id } });
  if (!bet) return { ok: false, reason: "This pick no longer exists." };

  const target = {
    sport: bet.sport,
    statMarket: bet.statMarket,
    marketType: bet.marketType as ClosingWorkItem["marketType"],
  };
  const plan = planOddsApiRead(target);
  if ("kind" in plan) return { ok: false, reason: plan.reason };

  const item: ClosingWorkItem = {
    id: bet.id,
    site: bet.site as ClosingWorkItem["site"],
    fantasyBook: bet.fantasyBook,
    marketType: bet.marketType as ClosingWorkItem["marketType"],
    player: bet.player,
    subjectTeam: bet.subjectTeam,
    matchup: bet.matchup,
    statMarket: bet.statMarket,
    side: bet.side as ClosingWorkItem["side"],
    externalPropId: bet.externalPropId,
    pageUrl: bet.pageUrl,
    gameStartTime: bet.gameStartTime?.toISOString() ?? null,
    sport: bet.sport,
    takenLine: bet.takenLine,
  };

  // Refresh means "ask again", so it must never be served the answer a moment ago produced. The
  // reader narrows this to its own publish interval -- see `fetchOdds`.
  const attempt = await previewNow(item, {
    allowCache: options.refresh !== true,
    source: options.source,
  });
  return { ok: true, mode: "result", preview: attempt.preview };
}
