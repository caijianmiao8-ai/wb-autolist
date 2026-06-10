// Cross-platform (Win/Mac/Linux) post-build prep for the Electron desktop bundle.
// Runs after `next build`. Replaces the Unix-only `cp`/`rm` so CI on Windows works.
import { rmSync, cpSync, existsSync } from "node:fs";

const SA = ".next/standalone";

// 1) drop any dev `data/` the Next file-tracer copied in (must NOT ship)
rmSync(`${SA}/data`, { recursive: true, force: true });

// 2) standalone doesn't auto-copy static assets — copy them in
cpSync(".next/static", `${SA}/.next/static`, { recursive: true });

// 3) public/ if present
if (existsSync("public")) cpSync("public", `${SA}/public`, { recursive: true });

console.log("✓ desktop:prep — standalone ready for electron-builder");
