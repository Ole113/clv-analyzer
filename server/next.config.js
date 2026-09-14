/** @type {import('next').NextConfig} */
const nextConfig = {
  // A production build and a running dev server must not share .next -- they clobber each
  // other's manifests and the dev server starts 500ing on every route.
  distDir: process.env.NODE_ENV === "production" ? ".next-build" : ".next",
  // @clv/shared ships TypeScript source so the extension and the closing fetcher share one parser.
  transpilePackages: ["@clv/shared"],
  serverExternalPackages: ["@prisma/client"],
  // Default server action body limit is 1MB; a multi-year Pikkit export's transactions.csv can
  // exceed that comfortably (store.ts's MAX_ROWS caps at 50,000 rows) well before it's unreasonable.
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};
module.exports = nextConfig;
