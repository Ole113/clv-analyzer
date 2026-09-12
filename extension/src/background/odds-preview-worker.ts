import type { ClosingReadOutcome, ClosingWorkItem } from "@clv/shared";
import { apiUrl, loadSettings } from "../content/shared/config";
import { readClosingLines } from "./closing-reader";

/**
 * Answers on-demand "what does the screen say right now" requests from the Odds modal, the same
 * way `closing-worker.ts` answers the scheduled closing-read queue -- same reader, same auth, same
 * PropProfessor-only endpoint. The two are kept as separate queues (see the module comment on
 * `/api/odds-preview-work`) rather than merged into one, so a burst of manual "check the odds"
 * clicks can never compete with or delay the real closing reads a pick only gets one shot at.
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
