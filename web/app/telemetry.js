/* telemetry.js - what the port reports about itself.
 *
 * kpwn's bo1z notes describe the same shape: a log tail plus frame records
 * posted to a telemetry endpoint, so a hosted port can tell whether the build
 * you deployed is the build that is actually running, and whether it crashed.
 *
 * EaglercraftX gives us three real hooks in eaglercraftXOpts.hooks:
 *   screenChanged(name, w, h, realW, realH, scale)  - which GUI screen the game
 *                                                   - is on, from the game's own
 *                                                   - GuiScreen class name
 *   crashReportShow(text, cb)                       - the game's crash report
 *   localStorageSaved / localStorageLoaded          - world/save traffic
 * plus its logger, which we capture through the loader's print hooks.
 */
window.mcTelemetry = (function () {
  const log = [];
  const events = [];
  let posted = 0, failed = 0, crash = null;
  let screen = null, screenSeq = 0;
  let wasmHeapMB = 0, wasmResizes = 0;
  let t0 = performance.now();

  function push(msg, level) {
    const s = String(msg);
    log.push(s);
    if (log.length > 5000) log.splice(0, log.length - 4000);

    /* the engine reports its own WASM linear-memory growth; grabbing it here is
     * cheaper than asking TeaVM for a heap dump */
    const m = /WebAssembly direct memory resized to ([\d.]+) MiB/.exec(s);
    if (m) { wasmHeapMB = parseFloat(m[1]); wasmResizes++; }

    return s;
  }

  function event(kind, detail) {
    events.push({ t: Math.round(performance.now() - t0), kind, detail });
    if (events.length > 400) events.shift();
  }

  return {
    push, event,
    logTail(n) { return log.slice(-(n || 60)); },
    events() { return events.slice(-40); },
    screens() { return { name: screen, seq: screenSeq }; },
    crash() { return crash; },
    heap() { return { wasmHeapMB, wasmResizes }; },
    counters() { return { posted, failed, logLines: log.length }; },

    screenChanged(name, w, h, rw, rh, scale) {
      screen = name; screenSeq++;
      event("screen", { name, w, h, rw, rh, scale });
      return true;   // hook return value is ignored by the engine
    },

    crashReportShow(text, cont) {
      crash = String(text).slice(0, 20000);
      event("crash", { bytes: crash.length });
      /* hand it straight to the endpoint: a crash that only exists in the tab
       * is worth nothing to whoever is hosting the port */
      this.post({ kind: "crash", crash });
      if (typeof cont === "function") cont(null);   // null = "do not add more notes"
    },

    async post(extra) {
      const body = Object.assign({
        kind: "stats",
        build: window.mcBoot && window.mcBoot.build,
        mode: window.mcBoot && window.mcBoot.mode,
        engine: (window.mcBoot && window.mcBoot.manifest && window.mcBoot.manifest.engine) || null,
        ua: navigator.userAgent,
        crossOriginIsolated: self.crossOriginIsolated,
        screen: screen,
        wasmHeapMB,
        jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        uptimeMs: Math.round(performance.now() - t0),
        assets: window.mcAsset ? window.mcAsset.counters() : {},
        mouse: window.mcMouseGuard ? window.mcMouseGuard.state() : null,
        events: this.events(),
        logTail: this.logTail(40)
      }, extra || {});

      try {
        const r = await fetch("/telemetry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        posted++;
      } catch (e) { failed++; }
      return body;
    }
  };
})();
