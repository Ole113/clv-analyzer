"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "../prisma";
import {
  importRows,
  PikkitFileError,
  readPikkitCsv,
  type PikkitImportResult,
} from "./store";

/**
 * Loading a Pikkit export.
 *
 * A server action rather than an API route: every mutation this dashboard performs is already one
 * (see `lib/bet-actions.ts` and the inline `"use server"` blocks on `/settings`), and nothing
 * outside the browser has a reason to post a CSV. The extension's API routes exist because a
 * different process calls them; this does not.
 *
 * Everything with logic in it lives in `store.ts` -- including the result types. A `"use server"`
 * module may export nothing but async functions: each export is compiled into a callable action,
 * so even a re-exported type fails the build. That also makes the logic untestable from here, so
 * what is left in this file is only the part that genuinely needs a request: reading the uploaded
 * File, and telling Next what to re-render.
 */

function refused(message: string, detail: string | null): PikkitImportResult {
  return { ok: false, message, detail, created: 0, updated: 0, failures: [] };
}

export async function importPikkitCsv(formData: FormData): Promise<PikkitImportResult> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return refused("No file chosen", "Pick the transactions.csv exported from Pikkit.");
  }

  let rows: Record<string, string>[];
  try {
    rows = readPikkitCsv(await file.text());
  } catch (error) {
    if (error instanceof PikkitFileError) return refused(error.message, error.detail);
    throw error;
  }

  const { created, updated, failures } = await importRows(rows);

  revalidatePath("/analysis");
  revalidatePath("/bets");

  const parts = [
    `${created} new`,
    `${updated} updated`,
    ...(failures.length ? [`${failures.length} could not be read`] : []),
  ];
  return {
    ok: true,
    message: `Imported ${created + updated} bet${created + updated === 1 ? "" : "s"}`,
    detail: parts.join(", "),
    created,
    updated,
    failures,
  };
}

/** Clears the whole Pikkit dataset. Legs cascade. Captured picks are untouched. */
export async function purgePikkitBets(): Promise<number> {
  const { count } = await prisma.pikkitBet.deleteMany({});
  revalidatePath("/analysis");
  revalidatePath("/bets");
  return count;
}

export async function countPikkitBets(): Promise<number> {
  return prisma.pikkitBet.count();
}
