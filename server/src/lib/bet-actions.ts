"use server";

import { revalidatePath } from "next/cache";
import { planScreenRead, type ClosingWorkItem } from "@clv/shared";
import { prisma } from "./prisma";
import type { ActionResult } from "@/components/action-button";
import { getPreviewResult, isPreviewPending, previewNow, type OddsPreview } from "./odds-preview";

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
 * Answers the Odds modal.
 *
 * `planScreenRead` is checked here, synchronously, before anything is attempted: a market with no
 * PropProfessor equivalent at all (or one this app has no alias for yet) will never succeed no
 * matter how many times it is retried, so the modal should say so at once.
 *
 * Everything past that check is handled by `previewNow`, which in the normal case reads the odds
 * screen from this process and returns the answer inside this one call. `queued` is the exception:
 * it means the server has no PropProfessor token yet and the request has been handed to the
 * extension, which is the only thing that can mint one -- that read costs a `chrome.alarms` period,
 * and is the only case where the modal still polls.
 */
export async function requestOddsPreview(
  id: string,
  options: { refresh?: boolean } = {}
): Promise<
  | { ok: true; mode: "result"; preview: OddsPreview }
  | { ok: true; mode: "queued" }
  | { ok: false; reason: string }
> {
  const bet = await prisma.bet.findUnique({ where: { id } });
  if (!bet) return { ok: false, reason: "This pick no longer exists." };

  const plan = planScreenRead({
    sport: bet.sport,
    statMarket: bet.statMarket,
    marketType: bet.marketType as ClosingWorkItem["marketType"],
  });
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

  // Refresh means "ask again", so it must never be served the answer a moment ago produced.
  const attempt = await previewNow(item, { allowCache: options.refresh !== true });
  return attempt.mode === "result"
    ? { ok: true, mode: "result", preview: attempt.preview }
    : { ok: true, mode: "queued" };
}

/** Polled by the Odds modal only while a request is sitting with the extension. */
export async function pollOddsPreview(id: string): Promise<{ pending: boolean; preview: OddsPreview | null }> {
  return { pending: isPreviewPending(id), preview: getPreviewResult(id) };
}
