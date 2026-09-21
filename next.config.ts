import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Prisma and bcryptjs are Node-only packages. Keeping them external prevents
   * the Next.js bundler from trying to bundle the Prisma query engine into the
   * server output, which is the documented configuration for Prisma + Next.js.
   */
  serverExternalPackages: ["@prisma/client", ".prisma/client", "bcryptjs"],
};

export default nextConfig;
