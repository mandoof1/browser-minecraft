# browser-minecraft — real Minecraft 1.8.8, in the browser

This is **Mojang's Minecraft 1.8.8 code**, compiled to WebAssembly, running in a
browser tab. Not a voxel game written to look like Minecraft: the class that
prints itself into the console here is `net.minecraft.client.gui.GuiMainMenu`,
the world save on disk is a Mojang `level.dat` that an independent NBT reader
parses, and the chunk format is the engine's own.

Live: **https://browser-minecraft.onrender.com/?build=wasm&theater=1**

```
?build=wasm          TeaVM WebAssembly-GC target (needs JSPI: Chrome/Brave/Edge)
?build=js            TeaVM JavaScript target (for browsers without JSPI, e.g. Safari)
?mode=files|epw      stream the artifacts, or hand the engine its single .epw bundle
?server=host:port    join a multiplayer server straight away
?lang=de_DE          force a locale
?worlds=name         IndexedDB namespace for worlds
?ramdisk=1           keep chunks in RAM instead of IndexedDB
?nocache=1           bypass the OPFS asset cache
?theater=1           no chrome, canvas fills the window
```

## What is actually here

```
web/index.html          the shell: canvas, boot log, stats bar
web/app/boot.js         builds eaglercraftXOpts, picks a target, hands the
                        engine its artifacts as blob: URLs
web/app/assetcache.js   HTTP Range streaming in 512 KiB blocks + OPFS cache,
                        manifest-hashed URLs
web/app/telemetry.js    the game's hooks (screenChanged, crashReportShow,
                        localStorage*) plus its logger, POSTed to /telemetry
tools/serve.py          the hosting half: COOP/COEP, Range/206, /health,
                        /telemetry
tools/get-engine.sh     fetches the pinned engine (GitHub mirrors of it are
                        DMCA'd — HTTP 451 — so this pulls from GitFlic)
build.sh                gradle: wasm-GC target and JavaScript target
tools/make-manifest.py  sizes + sha256 of every artifact -> web/build/manifest.json
tools/verify.mjs        does it boot, and does it boot clean
tools/playtest.mjs      drives a real game: create world, walk, jump, look,
                        mine, place, inventory, save, quit, reload, rejoin
tools/nbtcheck.py       independent level.dat reader, used to prove the save
tools/livecheck.mjs     is the deployed site up, isolated, Range-capable
```

## Two builds of the same Java

The engine is Java. It gets AOT-compiled twice, the same way the DOOM port
ships pthreads and ASYNCIFY builds of the same C engine:

| | `wasm` | `js` |
|---|---|---|
| gradle task | `target_teavm_wasm_gc:makeMainWasmClientBundle` | `target_teavm_javascript:makeMainOfflineDownload` |
| code | `classes.wasm` 14.2 MB | `classes.js` 14.9 MB |
| blocking calls | suspended **inside** WASM with `WebAssembly.Suspending` (JSPI) | rewritten as JS continuations |
| boot to first GUI | ~1.2 s | ~1.1 s |
| heap | 40.25 MiB linear memory, 8 resizes | 248 MiB JS heap |
| needs | JSPI — Chrome/Edge/Brave yes, **Safari no** | nothing special |

JSPI is the interesting half: the engine's `Thread.sleep`, IndexedDB reads,
image and audio decoders all block in Java, and the WASM-GC backend suspends
the whole wasm call at that point instead of turning every method in Minecraft
into an async function. That is what kpwn's Black Ops Zombies build does, and
it is exactly why Safari cannot run this port — the `js` target exists for it.

## The server is part of the port

`tools/serve.py` is not a convenience, it is a requirement:

* **COOP/COEP** — `crossOriginIsolated` for OPFS and any worker split.
* **Range / 206** — the asset layer pulls `classes.wasm` (14.2 MB) and
  `assets.epk` (11.7 MB) in 512 KiB blocks. Python's stock server answers
  `Range` with a `200`, which silently turns that into a full re-download.
* **/telemetry** — the port POSTs screen changes, heap growth, crash reports
  and a log tail to the same origin. It is the only way a hosted port can tell
  you which build is actually running.

## Verified, in a real browser

`node tools/verify.mjs wasm` and `node tools/verify.mjs js` both **PASS** in
headless Brave (SwiftShader GPU): module loads, artifacts arrive over Range and
land in OPFS, the engine canvas appears, and the first GUI screen reported by
the game itself is `net.lax1dude.eaglercraft.v1_8.profanity_filter.GuiScreenContentWarning`.

`node tools/playtest.mjs wasm` plays a game and checks it with pixel diffs:

| action | evidence |
|---|---|
| create world | `GuiCreateWorld` → in-game, `screen=null` |
| look down 45° | 86.7 % of pixels changed |
| walk forward 1.2 s | 60.9 % changed |
| jump | 48.4 % changed |
| hold left button 3.2 s | block-breaking animation, ~8 % changed |
| right button | place |
| `E` | inventory, 93.3 % changed |
| save and quit | IndexedDB `_..._PlatformFilesystem_1_8_8_browser-minecraft-worlds`, ~99 files |
| inspect the save | `level.dat` parses as NBT: `LevelName="portworldNNN"`, spawn, seed, player pos |
| reload the page | 9/9 artifacts served from the OPFS cache instead of the network |
| rejoin the world | view matches the one we left in **4.2 %** pixel terms |

The world is stored the EaglercraftX way: `worlds/<name>/level.dat` plus
`level0/<chunk>.dat` per chunk in IndexedDB, not `region/*.mca` — that is the
engine's browser storage format, not something this port invented.

## Engine and licensing

`tools/get-engine.sh` pins:

```
EaglercraftX 1.8 (Mojang Minecraft 1.8.8, decompiled + patched)
rev 746793a11eb67608b4e60660a4dfe205f5f68970  "u53"   2025-07-06
toolchain: gradle 8.14 (wrapper), JDK 17, TeaVM 0.12.1-EAGLER-R3
```

The engine is **not** in this repository and is not redistributed here. It is a
decompiled, patched Minecraft; Mojang's EULA does not permit handing out the
game, and GitHub mirrors of the EaglercraftX sources are under a DMCA takedown
(HTTP 451), which is why the fetch script uses a GitFlic mirror. The compiled
artifacts under `web/build/` are committed so that a deploy does not need a JDK
plus a gigabyte of Gradle cache — rebuild them with:

```
bash tools/get-engine.sh
TARGETS="wasm js" bash build.sh      # needs JDK 17
python3 tools/make-manifest.py
```

## Deploying

`render.yaml` describes a Python web service (`python3 tools/serve.py`,
healthcheck `/health`). The compiled game is committed, so the build step is
just `python3 tools/make-manifest.py`. Free tier: the service sleeps when idle
and a cold load pulls ~33 MB of wasm + assets, which the OPFS cache makes cheap
the second time.

```
node tools/livecheck.mjs https://browser-minecraft.onrender.com wasm,js
```

## Known rough edges

* Safari cannot run the `wasm` target (no JSPI). `?build=js` works there.
* The shared-world relays (`relay.deev.is`, …) are third-party; they are
  sometimes unreachable, and the client logs a WebSocket error when they are.
* Mouse look under headless pointer lock is hard to drive from a test harness;
  the playtest fakes it with large synthetic deltas and `?theater=1`.
* The playtest's block-break pixel diff is flaky (it depends on what the
  player happens to be standing in front of after spawning); the rest of the
  sequence is stable.
* OptiFine's texture-reload chatter dominates the game log.
