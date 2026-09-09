import { z } from "zod";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getBetDetail } from "@/lib/queries";
import { gradeBet, gradeManually } from "@/lib/grading/grader";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Grades this pick now, ignoring the schedule. Unlike the closing read -- which only the user's
 * browser can perform -- the server can do this inline, so the response carries the verdict.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(request)) return unauthorized();
  const { id } = await params;

  const existing = await prisma.bet.findUnique({ where: { id } });
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });

  await prisma.bet.update({
    where: { id },
    data: { gradeAttempts: 0, gradeReason: null, gradeScheduledAt: new Date() },
  });
  const outcome = await gradeBet(id);

  return Response.json({ ok: true, ...outcome, bet: await getBetDetail(id) });
}

const manualSchema = z
  .object({
    actualValue: z.number().finite().optional(),
    void: z.boolean().optional(),
  })
  .refine((v) => v.actualValue !== undefined || v.void === true, {
    message: "actualValue is required unless voiding the pick",
  });

/**
 * Records a hand-entered result for a pick no source can settle.
 *
 * The outcome is always *derived* from the value typed in -- a caller cannot supply both a value
 * and a contradicting result, so the stored actual and result can never disagree.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(request)) return unauthorized();
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = manualSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid payload", issues: parsed.error.issues }, { status: 422 });
  }

  if (parsed.data.void) {
    const bet = await prisma.bet.update({
      where: { id },
      data: {
        gradeResult: "VOID",
        actualValue: null,
        gradedAt: new Date(),
        gradeSource: "manual",
        gradeReason: "Voided by hand",
      },
    });
    return Response.json({ ok: true, result: bet.gradeResult });
  }

  const bet = await gradeManually(id, parsed.data.actualValue as number);
  if (!bet) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true, result: bet.gradeResult, actualValue: bet.actualValue });
}
