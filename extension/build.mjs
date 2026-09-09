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
