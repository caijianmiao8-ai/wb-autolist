/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 'standalone' emits a self-contained server (.next/standalone/server.js)
  // with only the needed node_modules — what the Electron desktop build ships.
  output: "standalone",
  experimental: {
    // sharp is a native dep used in server routes; keep it external so Next doesn't bundle it
    serverComponentsExternalPackages: ["sharp"],
  },
};

export default nextConfig;
