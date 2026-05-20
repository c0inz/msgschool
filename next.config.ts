import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 'standalone' bundles only the modules the runtime actually imports
  // into .next/standalone/, so the deployable footprint is ~50-80 MB
  // instead of the full 660 MB node_modules tree. The bot's start
  // command on prod is `next start`, which already reads from .next/;
  // this just shrinks what needs to live there.
  output: "standalone",
};

export default nextConfig;
