/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export — the Tauri shell serves these files; all backend work moved
  // to Rust commands (no Node server, no API routes).
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
