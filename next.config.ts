import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep pdfkit out of the webpack bundle so it loads its font data files (.afm)
  // from node_modules at runtime — bundling breaks those file lookups.
  serverExternalPackages: ["pdfkit"],
};

export default nextConfig;
