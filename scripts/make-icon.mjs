// Generate the app icon via Aurixel (gpt-image-2) and post-process it into a
// clean, transparent-corner PNG that electron-builder converts to .icns/.ico.
//
//   ~/.local/node/bin/node scripts/make-icon.mjs
//
// Re-run only when you want to regenerate the artwork. The committed
// assets/icon.png is what ships; this script is the reproducible source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── resolve the Aurixel key without hard-coding it: env > .env.local > config ──
function readKey() {
  if (process.env.AURIXEL_API_KEY) return process.env.AURIXEL_API_KEY;
  const envFile = path.join(ROOT, ".env.local");
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, "utf8").match(/^AURIXEL_API_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  for (const p of [path.join(ROOT, "data", "config.json"), "/tmp/wbsecrets/config.json"]) {
    try {
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      if (c.aurixelApiKey) return c.aurixelApiKey;
    } catch {
      /* ignore */
    }
  }
  throw new Error("找不到 AURIXEL_API_KEY（检查 .env.local 或 data/config.json）");
}

const PROMPT = `A modern minimalist mobile app icon, perfectly square with rounded corners (squircle). Vibrant magenta-to-violet diagonal gradient background (from #E6007E hot pink to #7B2FF7 purple). Centered white geometric mark: a clean parcel/shopping box outline merged with an upward arrow and a small spark, suggesting fast automated product listing. Flat vector design, bold thick strokes, high contrast, crisp edges, generous padding around the mark, no text, no letters, professional app store icon, soft inner glow. Solid background, no photographic elements, fill the entire frame to the edges.`;

async function generate(key) {
  const res = await fetch("https://conduit-api.aurixel.ai/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-image-2", prompt: PROMPT, size: "1024x1024", n: 1, quality: "high" }),
  });
  if (!res.ok) throw new Error(`Aurixel HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const item = json.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item?.url) return Buffer.from(await (await fetch(item.url)).arrayBuffer());
  throw new Error("Aurixel 未返回图片数据");
}

async function main() {
  const SIZE = 1024;
  const assets = path.join(ROOT, "assets");
  fs.mkdirSync(assets, { recursive: true });

  // Reuse an existing source if present (avoids re-spending on regeneration);
  // pass --force to always regenerate.
  const srcPath = path.join(assets, "icon-source.png");
  let raw;
  if (fs.existsSync(srcPath) && !process.argv.includes("--force")) {
    raw = fs.readFileSync(srcPath);
    console.log("复用 assets/icon-source.png（--force 可重新生成）");
  } else {
    console.log("调用 Aurixel 生成图标…");
    raw = await generate(readKey());
    fs.writeFileSync(srcPath, raw);
    console.log("已保存源图 →", path.relative(ROOT, srcPath));
  }

  // The model paints rounded corners on a solid (often black) frame. Trim that
  // uniform border, square it up, then punch transparent corners with a
  // rounded-rect alpha mask so the dock/taskbar icon has no black box.
  const squared = await sharp(raw)
    .trim({ threshold: 18 })
    .resize(SIZE, SIZE, { fit: "fill" })
    .toBuffer();

  const r = Math.round(SIZE * 0.235); // ≈ iOS squircle radius
  const mask = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}"><rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${r}" ry="${r}"/></svg>`
  );
  const rounded = await sharp(squared)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const iconPath = path.join(assets, "icon.png");
  fs.writeFileSync(iconPath, rounded);
  console.log("已写入应用图标 →", path.relative(ROOT, iconPath), `(${SIZE}×${SIZE}, 透明圆角)`);

  // A copy for the in-app brand mark.
  const pub = path.join(ROOT, "public");
  fs.mkdirSync(pub, { recursive: true });
  await sharp(rounded).resize(256, 256).png().toFile(path.join(pub, "logo.png"));
  console.log("已写入 UI Logo  → public/logo.png (256×256)");
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
