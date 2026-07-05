import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@household/backend", "@household/shared"],
};

export default nextConfig;
