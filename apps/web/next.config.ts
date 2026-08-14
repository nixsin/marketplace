import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Not content-hashed (fixed URL), so unlike /_next/static/* this
        // can't be `immutable` — a real favicon update needs to be visible
        // within a day, not cached forever. Still a real improvement over
        // the previous default of effectively no caching (found via the
        // cold vs. warm Lighthouse comparison — this was the one asset
        // still re-downloaded on every repeat visit).
        source: "/favicon.ico",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
    ];
  },
};

export default nextConfig;
