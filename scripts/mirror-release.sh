#!/usr/bin/env bash
# Mirror a GitHub release to the bifrostapi.net S3 bucket, so customers who can't
# reach GitHub can still download AND auto-update.
#
#   ./scripts/mirror-release.sh v1.0.39
#
# What it does:
#   1. downloads the release assets from GitHub
#   2. rewrites latest.json so every platform URL points at the mirror
#      (the minisign signatures stay untouched — the client still verifies them,
#      so a tampered mirror can never install a modified package)
#   3. uploads assets + the rewritten manifest under  download/
#   4. also publishes a STABLE filename that always points at the newest build,
#      so a link handed to a customer never goes out of date
#
# Only ever writes under the `download/` prefix — the rest of the website bucket
# (index.html, install/, assets/ …) is never touched, and nothing is deleted.
set -euo pipefail

TAG="${1:?用法: mirror-release.sh <tag>  例如 v1.0.39}"
REPO="${MIRROR_REPO:-Ruo-cc/wb-autolist}"
BUCKET="${MIRROR_BUCKET:-www.bifrostapi.net}"
PREFIX="${MIRROR_PREFIX:-download}"
BASE="${MIRROR_BASE_URL:-https://www.bifrostapi.net/${PREFIX}}"
GH="${GH_BIN:-gh}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "▶ 下载 $TAG 的发布文件…"
"$GH" release download "$TAG" --repo "$REPO" --dir "$work" --clobber

test -f "$work/latest.json" || { echo "✗ 该发布里没有 latest.json"; exit 1; }

echo "▶ 改写 latest.json 的下载地址 → $BASE"
python3 - "$work/latest.json" "$BASE" <<'PY'
import json, sys, urllib.parse
path, base = sys.argv[1], sys.argv[2].rstrip("/")
d = json.load(open(path))
for name, p in d.get("platforms", {}).items():
    url = p.get("url", "")
    if url:
        # keep only the file name; the signature field is left exactly as-is
        p["url"] = f"{base}/{urllib.parse.unquote(url.rsplit('/', 1)[-1])}"
json.dump(d, open(path, "w"), ensure_ascii=False, indent=2)
print("  " + "\n  ".join(f"{k} → {v['url']}" for k, v in d.get("platforms", {}).items()))
PY

echo "▶ 上传到 s3://$BUCKET/$PREFIX/"
for f in "$work"/*; do
  name="$(basename "$f")"
  # latest.json must never be cached for long or clients keep seeing the old
  # version; the immutable installers can be cached hard.
  if [ "$name" = "latest.json" ]; then
    cache="no-cache, max-age=60"
  else
    cache="public, max-age=31536000, immutable"
  fi
  aws s3 cp "$f" "s3://$BUCKET/$PREFIX/$name" --cache-control "$cache" --only-show-errors
  echo "  ✓ $name"
done

# Stable, version-less link for handing to customers.
win="$(ls "$work"/*x64-setup.exe 2>/dev/null | head -1 || true)"
if [ -n "$win" ]; then
  aws s3 cp "$win" "s3://$BUCKET/$PREFIX/WB-AutoList-Setup.exe" \
    --cache-control "no-cache, max-age=300" --only-show-errors
  echo "  ✓ WB-AutoList-Setup.exe (稳定链接,总是最新版)"
fi

echo
echo "✅ 完成。"
echo "   更新源清单: $BASE/latest.json"
echo "   客户下载:   $BASE/WB-AutoList-Setup.exe"
