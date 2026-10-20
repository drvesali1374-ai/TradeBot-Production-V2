import type { NextConfig } from "next";

/**
 * Official build/deployment path (mission §8): Cloudflare Pages via
 * @cloudflare/next-on-pages (standard Next build, edge runtime) + the
 * cloudflare/scheduler cron worker. `output: "standalone"` was removed —
 * it contradicted that path. TypeScript errors are FIXED, not ignored.
 */
const nextConfig: NextConfig = {
  reactStrictMode: false,
};

export default nextConfig;
