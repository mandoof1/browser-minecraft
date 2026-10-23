/* boot.js - the browser layer of this port.
 *
 * Everything here is ours; the game logic above it is Mojang's. The engine
 * reaches the browser through exactly one object, and this file builds it:
 *
 *   wasm + files  -> window.__eaglercraftXLoaderContext  (then eagruntime.js)
 *   wasm + epw    -> window.__eaglercraftXLoaderContextPre (then loader.js)
 *   js            -> window.eaglercraftXOpts + main()     (then classes.js)
 *
 * Query params this port adds on top of upstream's:
 *   build=wasm|js     which TeaVM target to run          (default wasm)
 *   mode=files|epw    26 MB of separate artifacts, or one 11.3 MB xz EPW
 *   server=ws://...   join this server on launch
 *   lang=en_US        locale
 *   worlds=name       IndexedDB namespace for saves
 *   demo=1            demo mode
 *   teadbg=1          load the 5 MB TeaVM stack-deobfuscation info
 *   opts=a=1,b=0      pass any eaglercraftXOpts knob straight through
 *   nocache=1         skip the OPFS asset cache (cold-boot measurement)
 */
(function () {
  const params = new URLSearchParams(location.search);
  const BUILD = params.get("build") || "wasm";
  const MODE = params.get("mode") || (BUILD === "wasm" ? "files" : "files");
  const BASE = "/build/";
  /* artifact names are manifest-relative, i.e. target-prefixed, so the cache
   * key, the URL and the pinned hash all come from the same string */
  const A = (f) => BUILD + "/" + f;
  const NOCACHE = params.get("nocache") === "1";
  if (params.get("theater") === "1") document.body.classList.add("theater");

  const el = (id) => document.getElementById(id);
  const logEl = el("log"), stageEl = el("stage"), progEl = el("prog"),
        statsEl = el("stats"), titleEl = el("title"), gameEl = el("game");

  const boot = {
    build: BUILD, mode: MODE, base: BASE, params: Object.fromEntries(params.entries()),
    phase: "start", t0: performance.now(), phases: {}, manifest: null,
    assets: {}, done: false, canvasSeen: false
  };
  window.mcBoot = boot;

  function log(msg, cls) {
    const line = document.createElement("span");
    line.className = cls || "k";
    line.textContent = String(msg) + "\n";
    logEl.appendChild(line);
    while (logEl.childNodes.length > 600) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
    window.mcTelemetry.push(msg);
  }
  function stage(t) {
    boot.phase = t;
    boot.phases[t] = Math.round(performance.now() - boot.t0);
    stageEl.textContent = t + " (+" + boot.phases[t] + "ms)";
  }
  function progress(done, total) {
    progEl.hidden = false;
    progEl.value = total ? Math.round((done / total) * 100) : 0;
  }
  window.mcLog = log;
  window.mcStage = stage;

  /* the engine logs through console, so the page's log panel and the telemetry
   * log tail come from wrapping console rather than from patching their JS */
  (function captureConsole() {
    const orig = {};
    for (const k of ["log", "info", "warn", "error"]) {
      orig[k] = console[k].bind(console);
      console[k] = function (...args) {
        try {
          const s = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
          window.mcTelemetry.push(s);
        } catch (e) { /* never break the game over a log line */ }
        return orig[k](...args);
      };
    }
  })();

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve(src);
      s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function asset(name, label) {
    const r = await window.mcAsset.bytes(name, {
      base: BASE, nocache: NOCACHE,
      onProgress: (done, total) => {
        stage("fetch " + (label || name));
        if (total) progress(done, total);
        boot.assets[name] = { bytes: done, total, source: "http" };
      }
    });
    boot.assets[name] = { bytes: r.bytes.length, source: r.source };
    log(name + ": " + r.bytes.length + " bytes via " + r.source +
        " -> " + (r.bytes.length / 1048576).toFixed(1) + " MiB", "ok");
    progEl.hidden = true;
    return r.bytes;
  }

  async function assetURL(name, mime, label) {
    const r = await window.mcAsset.blobURL(name, mime, {
      base: BASE, nocache: NOCACHE,
      onProgress: (done, total) => { stage("fetch " + (label || name)); if (total) progress(done, total); }
    });
    boot.assets[name] = { bytes: r.bytes, source: r.source };
    log(name + ": " + r.bytes + " bytes via " + r.source + " -> blob: URL", "ok");
    progEl.hidden = true;
    return r.url;
  }

  /* ---- eaglercraftXOpts, with this port's hooks attached ------------------ */
  function buildOpts(extra) {
    const relayId = Math.floor(Math.random() * 3);
    const hooks = {
      screenChanged: (n, w, h, rw, rh, sc) => {
        /* first call proves the engine has already loaded our hooks into its
         * config adapter, so drop them from the opts object now: EaglercraftX
         * hands that very object to the integrated-server worker with
         * postMessage when you enter singleplayer, and structured clone
         * refuses functions - leaving them in place kills the game with
         * DataCloneError the moment you create a world */
        if (o.hooks) o.hooks = null;
        window.mcTelemetry.screenChanged(n, w, h, rw, rh, sc);
        const s = window.mcTelemetry.screens();
        el("screenname").textContent = s.name || "-";
      },
      crashReportShow: (txt, cont) => window.mcTelemetry.crashReportShow(txt, cont),
      localStorageSaved: (k, data) => window.mcTelemetry.event("localStorageSaved", { key: String(k), bytes: data ? String(data).length : 0 }),
      /* the contract is "return the stored base64 string, or null": returning
       * undefined is a JS value TeaVM's adapter refuses to coerce to a String,
       * which throws inside the JS target on every settings/profile load */
      localStorageLoaded: (k) => {
        window.mcTelemetry.event("localStorageLoaded", { key: String(k) });
        return null;
      }
    };

    const o = Object.assign({
      demoMode: params.get("demo") === "1",
      worldsDB: params.get("worlds") || "browser-minecraft-worlds",
      localesURI: BASE + BUILD + "/lang/",
      allowVoiceClient: false,
      crashOnUncaughtExceptions: false,
      enableMinceraft: true,
      relays: [
        { addr: "wss://relay.deev.is/", comment: "lax1dude relay #1", primary: relayId === 0 },
        { addr: "wss://relay.lax1dude.net/", comment: "lax1dude relay #2", primary: relayId === 1 },
        { addr: "wss://relay.shhnowisnottheti.me/", comment: "ayunami relay #1", primary: relayId === 2 }
      ]
    }, extra || {});

    o.hooks = hooks;

    if (params.get("server")) o.joinServer = params.get("server");
    if (params.get("lang")) o.lang = params.get("lang");
    if (params.get("bootmenu") === "1") o.allowBootMenu = true;
    if (params.get("profanity") === "1") o.forceProfanityFilter = true;
    if (params.get("vsync") !== null) o.enforceVSync = params.get("vsync") === "1";
    if (params.get("ramdisk") === "1") o.ramdiskMode = true;
    if (params.get("gl") === "1") o.forceWebGL1 = true;
    if (params.get("gl") === "2") o.forceWebGL2 = true;

    /* opts=k=v passthrough: any knob in the engine's own config adapter */
    const raw = params.get("opts");
    if (raw) {
      for (const pair of raw.split(",")) {
        const i = pair.indexOf("=");
        if (i < 0) continue;
        const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
        if (v === "true" || v === "1") o[k] = true;
        else if (v === "false" || v === "0") o[k] = false;
        else if (/^-?\d+(\.\d+)?$/.test(v)) o[k] = Number(v);
        else o[k] = v;
      }
    }
    return o;
  }

  /* ---- the three load paths --------------------------------------------- */
  async function bootWasmFiles() {
    stage("load loader context");
    const [runtimeURL, classesURL, epk, langEpk] = await Promise.all([
      assetURL(A("eagruntime.js"), "text/javascript", "eagruntime.js"),
      assetURL(A("classes.wasm"), "application/wasm", "classes.wasm"),
      asset(A("assets.epk"), "assets.epk"),
      asset(A("lang.tmp.epk"), "lang.epk")
    ]);
    const imgs = {};
    for (const [i, f] of [[0, "splash.png"], [1, "pressAnyKey.png"], [2, "crashLogo.png"], [3, "favicon.png"]]) {
      imgs[i] = await assetURL(A(f), "image/png");
    }
    const deobf = await assetURL(A("classes.wasm-deobfuscator.wasm"), "application/wasm");
    const teadbg = params.get("teadbg") === "1"
      ? await assetURL(A("classes.wasm.teadbg"), "application/octet-stream") : null;

    stage("hand the engine its data");
    const opts = buildOpts();
    window.__eaglercraftXLoaderContext = {
      getEaglercraftXOpts: () => opts,
      getEagRuntimeJSURL: () => runtimeURL,
      getClassesWASMURL: () => classesURL,
      getClassesDeobfWASMURL: () => deobf,
      getClassesTEADBGURL: () => teadbg,
      getEPKFiles: () => [
        { name: "assets.epk", path: "", data: epk },
        { name: "lang.tmp.epk", path: "/assets/minecraft/lang/", data: langEpk }
      ],
      getRootElement: () => gameEl,
      getMainArgs: () => [],
      getImageURL: (idx) => imgs[idx] || null,
      runMain: (fn) => setTimeout(fn, 10)
    };

    stage("start engine");
    await loadScript(runtimeURL);
  }

  async function bootWasmEPW() {
    stage("load epw bundle");
    const epw = await asset(A("assets.epw"), "assets.epw (xz bundle)");
    const loaderWASM = await assetURL(A("loader.wasm"), "application/wasm");
    const splash = await assetURL(A("splash.png"), "image/png");

    stage("start engine");
    window.__eaglercraftXLoaderContextPre = {
      rootElement: gameEl,
      eaglercraftXOpts: buildOpts(),
      theEPWFileBuffer: epw,
      loaderWASMURL: loaderWASM,
      splashURL: splash
    };
    await loadScript(BASE + BUILD + "/loader.js");
  }

  async function bootJS() {
    stage("load classes.js");
    const classesURL = await assetURL(A("classes.js"), "text/javascript", "classes.js");
    const epkURL = await assetURL(A("assets.epk"), "application/octet-stream", "assets.epk");

    stage("start engine");
    await loadScript(classesURL);
    if (typeof window.main !== "function") throw new Error("classes.js did not define main()");
    window.eaglercraftXOpts = buildOpts({
      container: "game",
      assetsURI: epkURL,
      localesURI: BASE + BUILD + "/lang/"
    });
    window.main();
  }

  /* ---- page-side stats bar ---------------------------------------------- */
  let frames = 0, lastHud = 0;
  (function raf() {
    frames++;
    const now = performance.now();
    if (now - lastHud > 1000) {
      lastHud = now;
      const h = window.mcTelemetry.heap();
      const s = window.mcTelemetry.screens();
      const up = (now - boot.t0) / 1000;
      const bytes = Object.values(boot.assets).reduce((a, x) => a + (x.bytes || 0), 0);
      const cached = Object.values(boot.assets).filter(x => /opfs/.test(x.source || "")).length;
      statsEl.textContent =
        "build " + BUILD + "/" + MODE +
        " · raf " + frames + "/s" +
        " · screen " + (s.name || "-") +
        " · wasm heap " + h.wasmHeapMB + " MiB" +
        " · js heap " + (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : "?") + " MiB" +
        " · assets " + (bytes / 1048576).toFixed(1) + " MiB (" + cached + " from OPFS)" +
        " · up " + up.toFixed(0) + "s";
      frames = 0;
    }
    requestAnimationFrame(raf);
  })();

  /* a canvas inside the container means the engine got as far as its own GUI */
  new MutationObserver(() => {
    if (!boot.canvasSeen && gameEl.querySelector("canvas")) {
      boot.canvasSeen = true;
      boot.phases.canvas = Math.round(performance.now() - boot.t0);
      log("engine created its canvas (+" + boot.phases.canvas + " ms)", "ok");
      window.mcTelemetry.event("canvas", boot.phases.canvas);
    }
  }).observe(gameEl, { childList: true, subtree: true });

  async function main() {
    const iso = self.crossOriginIsolated;
    /* the engine's own crash hook covers a crash inside Minecraft; these cover
     * the port layer and the engine's JS runtime around it */
    addEventListener("error", (e) => window.mcTelemetry.crashReportShow(
      "window error: " + (e.message || "") + "\n" + ((e.error && e.error.stack) || ""), null));
    addEventListener("unhandledrejection", (e) => window.mcTelemetry.crashReportShow(
      "unhandled rejection: " + ((e.reason && (e.reason.message || e.reason)) || ""), null));

    log("browser-minecraft · build=" + BUILD + "/" + MODE +
        " · JSPI=" + (typeof WebAssembly.Suspending === "function") +
        " · crossOriginIsolated=" + iso, "dim");

    boot.manifest = await window.mcAsset.init(BASE);
    const eng = boot.manifest.engine || {};
    titleEl.textContent = "browser-minecraft · Minecraft 1.8.8 in WebAssembly";
    log("engine " + (eng.rev || "?").slice(0, 12) + " · " + (eng.subject || ""), "dim");
    log("toolchain " + JSON.stringify(boot.manifest.toolchain || {}), "dim");

    if (BUILD === "wasm" && typeof WebAssembly.Suspending !== "function") {
      log("this browser has no JSPI (WebAssembly.Suspending): the WASM-GC build cannot run. " +
          "Use ?build=js - that is the same Java compiled to JavaScript, and it needs no JSPI.", "err");
      stage("JSPI missing");
      return;
    }

    if (NOCACHE) log("nocache=1: OPFS asset cache disabled for this load", "dim");

    if (BUILD === "js") await bootJS();
    else if (MODE === "epw") await bootWasmEPW();
    else await bootWasmFiles();

    boot.done = true;
    stage("running");
    log("boot sequence handed over to the engine in " +
        Math.round(performance.now() - boot.t0) + " ms", "ok");

    setInterval(() => window.mcTelemetry.post(), 15000);
  }

  main().catch(e => {
    log("startup failed: " + ((e && e.message) || e), "err");
    stage("failed");
  });
})();
