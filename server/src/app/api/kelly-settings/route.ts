import { z } from "zod";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { getAppSettings, saveKellySettings } from "@/lib/app-settings";

export const dynamic = "force-dynamic";

/**
 * The Kelly numbers, for the extension.
 *
 * They live in `AppSettings` and are edited on the dashboard's Settings page, so that the bankroll
 * is one number rather than one per browser. The Kelly button on OddsJam's bet tracker reads them
 * through here, and writes back through the same route when "Save as defaults" is pressed there --
 * which is the one case where the number is decided on the board rather than on the dashboard.
 *
 * The board is never blocked on this call: the extension caches the last good answer and falls back
 * to it, and then to the built-in defaults, so a server that is off or unreachable costs the
 * bankroll being a little stale, not the button disappearing.
 */

const saveSchema = z.object({
  bankroll: z.number().finite().min(0).max(100_000_000),
  kellyMultiplier: z.number().finite().gt(0).max(1),
  unitSize: z.number().finite().min(0).max(1_000_000),
});

export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized();
  const settings = await getAppSettings();
  return Response.json({ ok: true, kelly: settings.kelly });
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid payload" }, { status: 422 });
  }

  // The board list is deliberately not writable from here. It is a configuration decision about
  // which sites the extension touches, and the one place to make that decision is the Settings
  // page -- not a button on a page OddsJam serves.
  const current = await getAppSettings();
  await saveKellySettings({ ...parsed.data, kellyBoards: current.kelly.kellyBoards });

  const saved = await getAppSettings();
  return Response.json({ ok: true, kelly: saved.kelly });
}
