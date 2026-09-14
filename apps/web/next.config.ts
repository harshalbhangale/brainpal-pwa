import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";

/**
 * Serwist configures the service worker through webpack, which Next 16 no
 * longer runs by default. So `dev` uses Turbopack — where Serwist is disabled
 * anyway — and `build` passes --webpack so the worker is actually generated.
 */
const withSerwist = withSerwistInit({
  swSrc: "src/sw.ts",
  swDest: "public/sw.js",
  // A service worker caching a half-built app is worse than none at all.
  disable: process.env.NODE_ENV === "development",
});

const config: NextConfig = {
  transpilePackages: ["@brainpal/ui", "@brainpal/contracts"],
};

export default withSerwist(config);
