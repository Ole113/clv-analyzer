import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: {
    "content/oddsjam": "src/content/oddsjam/index.ts",
    "content/propprofessor": "src/content/propprofessor/index.ts",
    "background/service-worker": "src/background/service-worker.ts",
    "options/options": "src/options/options.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "es2022",
  logLevel: "info",
};

mkdirSync("dist/options", { recursive: true });
cpSync("manifest.json", "dist/manifest.json");
cpSync("src/options/options.html", "dist/options/options.html");

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching...");
} else {
  await build(options);
}
