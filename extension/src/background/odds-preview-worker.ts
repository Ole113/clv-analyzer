import type { ClosingReadOutcome, ClosingWorkItem } from "@clv/shared";
import { apiUrl, loadSettings } from "../content/shared/config";
import { readClosingLines } from "./closing-reader";

/**
 * Answered on-demand "what does the screen say right now" requests from the Odds modal, the same
 * way `closing-worker.ts` answered the scheduled closing-read queue -- same reader, same auth, same
 * PropProfessor-only endpoint.
 *
 * Disabled along with `closing-worker.ts`: nothing calls `runOddsPreviewWork` any more, and the
 * Odds modal now answers from The Odds API inside its own request instead of queuing through here.
 * See `closing-worker.ts` for why.
 */
let inFlight = false;

export async function runOddsPreviewWork(): Promise<number> {
  if (inFlight) return 0;
  inFlight = true;
  try {
    return await runInner();
  } finally {
    inFlight = false;
  }
}

async function runInner(): Promise<number> {
  const settings = await loadSettings();
  if (!settings.backendUrl || !settings.apiKey) return 0;

  let work: ClosingWorkItem[] = [];
  try {
    const response = await fetch(apiUrl(settings.backendUrl, "/api/odds-preview-work"), {
      headers: { "x-api-key": settings.apiKey },
    });
    if (!response.ok) return 0;
    const body = (await response.json()) as { work?: ClosingWorkItem[] };
    work = body.work ?? [];
  } catch {
    return 0; // server unreachable; the modal's own poll will keep waiting and can be refreshed
  }

  if (work.length === 0) return 0;

  const outcomes = await readClosingLines(work);

  let handled = 0;
  for (const item of work) {
    const outcome = outcomes.get(item.id);
    if (!outcome) continue;
    if (await report(settings, item.id, outcome)) handled++;
  }
  return handled;
}

async function report(
  settings: { backendUrl: string; apiKey: string },
  betId: string,
  outcome: ClosingReadOutcome
): Promise<boolean> {
  try {
    const response = await fetch(apiUrl(settings.backendUrl, "/api/odds-preview-work"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify({ betId, outcome }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
