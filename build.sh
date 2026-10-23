#!/usr/bin/env bash
# Build real Minecraft 1.8.8 for the browser, twice, from one engine tree.
#
#   wasm  - TeaVM's **WebAssembly GC** backend (target_teavm_wasm_gc).
#           Minecraft's Java bytecode is AOT-compiled into classes.wasm. The
#           engine's blocking loop (sleep, IndexedDB reads, image decode, audio
#           decode) is suspended *inside* WASM with WebAssembly.Suspending -
#           JSPI - which is the same trick kpwn documented for the Black Ops
#           Zombies build and the reason Safari cannot run it.
#   js    - TeaVM's JavaScript backend (target_teavm_javascript). Same Java,
#           emitted as classes.js. No JSPI, so it runs in browsers that lack it.
#
# This is the "two shapes of the same engine" trick from the DOOM port
# (pthreads vs ASYNCIFY), applied to a game whose code is Java rather than C.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$HERE/engine/eaglercraft-1_8-workspace"
OUT="$HERE/web/build"

# Gradle's toolchain block in the engine asks for Java 17 specifically; JDK 21
# will compile the tree but TeaVM's plugin is built against 17.
if [ -z "${JAVA_HOME:-}" ] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -q 'version "17'; then
  for d in /usr/lib/jvm/java-17-openjdk /usr/lib/jvm/java-17 /opt/java-17; do
    if [ -x "$d/bin/javac" ]; then export JAVA_HOME="$d"; break; fi
  done
fi
echo "[build] JAVA_HOME=${JAVA_HOME:-<none>} ($([ -n "${JAVA_HOME:-}" ] && "$JAVA_HOME/bin/java" -version 2>&1 | head -1))"

[ -d "$ENGINE/.git" ] || { echo "engine missing - run tools/get-engine.sh first"; exit 1; }

cd "$ENGINE"
chmod +x gradlew

TARGETS="${TARGETS:-wasm js}"
tasks=()
for t in $TARGETS; do
  case "$t" in
    wasm) tasks+=( target_teavm_wasm_gc:makeMainWasmClientBundle ) ;;
    js)   tasks+=( target_teavm_javascript:makeMainOfflineDownload ) ;;
    *) echo "unknown target '$t' (want wasm and/or js)"; exit 1 ;;
  esac
done

echo "[build] gradle: ${tasks[*]}"
./gradlew --console=plain "${tasks[@]}"

mkdir -p "$OUT"

copy() { # src dst
  mkdir -p "$(dirname "$2")"
  cp -f "$1" "$2"
}

if [[ " $TARGETS " == *" wasm "* ]]; then
  S="$ENGINE/target_teavm_wasm_gc"
  D="$OUT/wasm"
  mkdir -p "$D"
  for f in classes.wasm eagruntime.js loader.js loader.wasm assets.epk lang.tmp.epk \
           assets.epw splash.png pressAnyKey.png crashLogo.png favicon.png \
           classes.wasm-deobfuscator.wasm epw_src.txt epw_meta.txt; do
    [ -f "$S/javascript/$f" ] && copy "$S/javascript/$f" "$D/$f"
  done
  # classes.wasm.teadbg (5 MB of TeaVM debug info for stack deobfuscation) is
  # left out of the repo; set TEADBG=1 to copy it if you are debugging crashes.
  [ "${TEADBG:-0}" = 1 ] && copy "$S/javascript/classes.wasm.teadbg" "$D/classes.wasm.teadbg"
  echo "[build] wasm -> $(du -sh "$D" | cut -f1)"
fi

if [[ " $TARGETS " == *" js "* ]]; then
  S="$ENGINE/target_teavm_javascript"
  D="$OUT/js"
  mkdir -p "$D"
  for f in classes.js assets.epk lang.tmp.epk favicon.png; do
    [ -f "$S/javascript/$f" ] && copy "$S/javascript/$f" "$D/$f"
  done
  # the JS target's localesURI is a directory of .lang files
  mkdir -p "$D/lang"
  cp -f "$S/javascript/lang/"*.lang "$D/lang/" 2>/dev/null || true
  echo "[build] js -> $(du -sh "$D" | cut -f1)"
fi

python3 "$HERE/tools/make-manifest.py" "$OUT"
echo "[build] done"
