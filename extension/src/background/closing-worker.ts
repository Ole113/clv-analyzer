import type { ClosingReadOutcome, ClosingWorkItem } from "@clv/shared";
import { apiUrl, loadSettings } from "../content/shared/config";
import { readClosingLines } from "./closing-reader";

/**
 * Drives the closing-read queue: asks the server what is due, has the reader price it, reports back.
 *
 * The server owns the schedule because it knows when each game starts; this worker owns the
 * reading. What it no longer owns is any notion of *which site* to read -- every close comes from
 * PropProfessor's odds screen regardless of where the pick was captured, so the old board map and
 * its `pageUrl` override are gone.
 *
 * That removal is a safety fix, not a tidy-up. This worker used to open
 * `fantasy.oddsjam.com/fantasy-odds/<book>` in a background tab every 60 seconds for every due
 * OddsJam pick. The OddsJam subscription is paid a year up front, so a ban is unrecoverable; the
 * PropProfessor account is replaceable. Reading the DOM of an OddsJam page the *user* opened is
 * still fine and still happens at capture time -- it sends them no requests. What is forbidden is
 * this worker initiating contact on a timer. There is a test asserting no module in this directory
 * names oddsjam.com, because that is exactly the kind of rule a later refactor undoes silently.
 */

/**
 * Guards against the 60s alarm re-entering a run that is still going.
 *
 * Less critical now that a read is one fetch rather than a 45-second tab dance, but the queue is
 * served in batches and a slow network still overlaps runs, which meant the same pick being read
 * and reported twice.
 */
let inFlight = false;

/** Asks the server what is due, reads each close, and reports back. Returns how many it handled. */
export async function runClosingWork(): Promise<number> {
  if (inFlight) return 0;
  inFlight = true;
  try {
    return await runClosingWorkInner();
  } finally {
    inFlight = false;
  }
}

async function runClosingWorkInner(): Promise<number> {
  const settings = await loadSettings();
  if (!settings.backendUrl || !settings.apiKey) return 0;

  let work: ClosingWorkItem[] = [];
  try {
    const response = await fetch(apiUrl(settings.backendUrl, "/api/closing-work"), {
      headers: { "x-api-key": settings.apiKey },
    });
    if (!response.ok) return 0;
    const body = (await response.json()) as { work?: ClosingWorkItem[] };
    work = body.work ?? [];
  } catch {
    return 0; // server unreachable; try again on the next alarm
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
    const response = await fetch(apiUrl(settings.backendUrl, "/api/closing-snapshots"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify({ betId, outcome }),
    });
    return response.ok;
  } catch {
    // Leave it due; the lease expires and the server hands it back on a later poll.
    return false;
  }
}
