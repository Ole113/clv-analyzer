import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Every path here is resolved against this file, not process.cwd(), so the build behaves the
// same whether it is run via `npm run build --workspace extension`, from inside extension/, or
// as `node extension/build.mjs` from the repo root. Relying on cwd used to fail with a bare
// "ENOENT: no such file or directory, lstat 'manifest.json'" and leave a stray dist/ behind.
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");

const watch = process.argv.includes("--watch");

const options = {
  // Makes esbuild resolve the entry points and outdir below against the extension directory.
  absWorkingDir: here,
  entryPoints: {
    "content/oddsjam": "src/content/oddsjam/index.ts",
    "content/propprofessor": "src/content/propprofessor/index.ts",
    // Runs in the page's own JS world to observe the odds-screen bearer token, plus the
    // isolated-world half that can actually talk to the background worker.
    "content/pp-token-bridge": "src/content/propprofessor/token-bridge.ts",
    "content/pp-token-relay": "src/content/propprofessor/token-relay.ts",
    // Also page-world: AG Grid's external filter (the only thing that can hide a row correctly on
    // a virtualized grid) is reachable only through the grid API, which lives in page context.
    "content/pp-grid-bridge": "src/content/propprofessor/grid-bridge.ts",
    // The +EV page is not a capture board -- it mounts the Kelly button and nothing else.
    "content/pp-positive-ev": "src/content/propprofessor/positive-ev.ts",
    // oddsjam.com itself: passively fills the deep-link cache from every page it is on, and
    // finishes a deep link the board could not answer when the tab was opened carrying one.
    "content/oddsjam-site": "src/content/oddsjam-site/index.ts",
    // oddsterminal.org: does nothing at all unless the page was opened carrying a request id in
    // its fragment, in which case it reads one market and hands the bytes back. Isolated world --
    // the session is a cookie, so nothing here needs page context.
    "content/oddsterminal-site": "src/content/oddsterminal-site/relay.ts",
    // Registered at runtime rather than in the manifest -- the dashboard's origin is whatever the
    // user configured -- so it has no `content_scripts` entry to match it against.
    "content/dashboard-warm": "src/content/dashboard/warm.ts",
    "background/service-worker": "src/background/service-worker.ts",
    "options/options": "src/options/options.ts",
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  target: "es2022",
  logLevel: "info",
};

mkdirSync(join(dist, "options"), { recursive: true });
cpSync(join(here, "manifest.json"), join(dist, "manifest.json"));
cpSync(join(here, "src", "options", "options.html"), join(dist, "options", "options.html"));

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching...");
} else {
  await build(options);
}
