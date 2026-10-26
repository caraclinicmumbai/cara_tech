import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep pdfkit out of the webpack bundle so it loads its font data files (.afm)
  // from node_modules at runtime — bundling breaks those file lookups.
  serverExternalPackages: ["pdfkit"],
  // The online booking widget (§3.2 2.3) is embedded in an iframe on the clinic's own
  // website — and only there. Everything else keeps the browser default.
  async headers() {
    const origins = (process.env.BOOKING_EMBED_ORIGINS ?? "https://caraclinics.com https://www.caraclinics.com").trim();
    return [
      {
        source: "/book/:path*",
        headers: [{ key: "Content-Security-Policy", value: `frame-ancestors 'self' ${origins}` }],
      },
    ];
  },
};

export default nextConfig;
