/**
 * Shared-secret auth between the extension and this server. Tailscale already restricts who can
 * reach the box; this stops anything else on the tailnet from writing bets.
 */
export function isAuthorized(request: Request): boolean {
  const expected = process.env.API_KEY;
  if (!expected || expected === "change-me") return false;
  const provided = request.headers.get("x-api-key");
  if (!provided || provided.length !== expected.length) return false;
  // Constant-time-ish compare; lengths already match.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
