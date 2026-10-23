#!/usr/bin/env bash
# Fetch the engine tree this port is built from.
#
# It is NOT committed here, and that is deliberate. The tree is Mojang's own
# Minecraft 1.8.8 code - decompiled, renamed with MCP mappings, and patched by
# the Eaglercraft project - and Mojang DMCA'd 389 repositories holding exactly
# that source on 2026-09-14 (github/dmca: 2026-09-14-minecraft-2.md, "The entire
# repository is infringing"). Redistributing it is the radioactive part of every
# Minecraft browser port, so we pin it by commit and fetch it instead.
#
#   engine/eaglercraft-1_8-workspace   <- what build.sh compiles
#   engine/eaglercraft-1_8             <- upstream's patch pipeline (mcp918 +
#                                          patches/) if you want to see how the
#                                          decompiled tree is produced
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="$HERE/engine/eaglercraft-1_8-workspace"

# Pinned: EaglercraftX 1.8 "Update #53" workspace tree.
ENGINE_URL="${ENGINE_URL:-https://gitflic.ru/project/lax1dude/eaglercraft-1_8-workspace}"
ENGINE_REV="${ENGINE_REV:-746793a11eb67608b4e60660a4dfe205f5f68970}"

mkdir -p "$HERE/engine"

if [ ! -d "$ENGINE/.git" ]; then
  echo "[engine] cloning $ENGINE_URL"
  git clone "$ENGINE_URL" "$ENGINE"
fi

cd "$ENGINE"
if ! git cat-file -e "$ENGINE_REV^{commit}" 2>/dev/null; then
  echo "[engine] fetching $ENGINE_REV"
  git fetch --depth 1 origin "$ENGINE_REV" || git fetch origin "$ENGINE_REV"
fi

git checkout -q "$ENGINE_REV"
echo "[engine] pinned rev   $(git rev-parse HEAD)"
echo "[engine] commit date  $(git log -1 --format=%ci)"
echo "[engine] subject      $(git log -1 --format=%s)"
