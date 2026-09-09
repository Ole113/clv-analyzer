import { isAuthorized, unauthorized } from "@/lib/auth";
import { runDueGrades } from "@/lib/grading/grader";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Runs one grading pass on demand -- used by the Settings button and for testing. */
export async function POST(request: Request) {
  if (!isAuthorized(request)) return unauthorized();
  const graded = await runDueGrades();
  return Response.json({ ok: true, graded });
}
