/**
 * Next runs this once when the server process boots.
 *
 * The grader lives here (rather than in the extension, like the closing-line read) because the
 * stats sources are public: no login, no Cloudflare, no browser. It therefore keeps working when
 * Chrome is closed.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.CLV_DISABLE_GRADER === "true") return;
  const { startGrader } = await import("./lib/grading/grader");
  startGrader();
}
