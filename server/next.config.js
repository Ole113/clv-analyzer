/** @type {import('next').NextConfig} */
const nextConfig = {
  // A production build and a running dev server must not share .next -- they clobber each
  // other's manifests and the dev server starts 500ing on every route.
  distDir: process.env.NODE_ENV === "production" ? ".next-build" : ".next",
  // @clv/shared ships TypeScript source so the extension and the closing fetcher share one parser.
  transpilePackages: ["@clv/shared"],
  serverExternalPackages: ["@prisma/client"],
};
module.exports = nextConfig;
