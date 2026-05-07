import type { NextConfig } from "next";

const config: NextConfig = {
  // ISR-friendly defaults; agencies can tune per-route via fetch options.
  experimental: {
    typedRoutes: true,
  },
};

export default config;
