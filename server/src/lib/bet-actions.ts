"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "./prisma";
import type { ActionResult } from "@/components/action-button";

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
