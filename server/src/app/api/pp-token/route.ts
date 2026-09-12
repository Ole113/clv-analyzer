import { z } from "zod";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { hasPpToken, storePpToken } from "@/lib/pp-token";

export const dynamic = "force-dynamic";

/**
 * Where the extension relays PropProfessor's odds-screen bearer token.
 *
 * This is what makes the Odds modal fast. Before it, every "current odds" click had to be parked in
 * a queue until the extension's next `chrome.alarms` tick (Chrome's floor is one minute) came to
 * collect it, because the browser was the only place the token existed. With the token here, the
 * server makes the same request itself and answers inside the modal's own round trip.
 *
 * The token is held in memory and never written to the database, never logged, and never returned
 * in a response -- `GET` reports only whether one is present, which is what the extension uses to
 * decide whether it needs to push again after a server restart.
 *
 * Authenticated like every other extension endpoint. That matters more here than elsewhere: this
 * accepts a credential, so an unauthenticated caller could otherwise poison it with a token of
 * their choosing and have this server send requests carrying it.
 */

const tokenSchema = z.object({
  // A bearer JWT. Bounded rather than unbounded so a runaway or malicious caller cannot park
  // megabytes in the process; the real tokens are a few hundred bytes.
  token: z.string().min(20).max(4096),
});

export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized();
  return Response.json({ ok: true, hasToken: hasPpToken() });
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = tokenSchema.safeParse(body);
  // Deliberately no `issues` echo here, unlike the other routes: the failing value is a credential.
  if (!parsed.success) return Response.json({ error: "invalid payload" }, { status: 422 });

  storePpToken(parsed.data.token);
  return Response.json({ ok: true });
}
