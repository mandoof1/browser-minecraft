/* mouselook.js - the port's mouse-look guard.
 *
 * The engine's browser input layer hands the camera whatever movementX/Y a
 * mousemove carries, and three things in it make the camera snap to full pitch,
 * spin, or "go everywhere". None of them is ours to patch (the engine is not
 * vendored), so this file fixes all three from outside:
 *
 *   1. A stale "I own the mouse" flag. platformInput.js sets pointerLockFlag
 *      when it *asks* for pointer lock, and its pointerlockerror handler clears
 *      only the waiting flag. Chrome refuses a re-lock for about a second after
 *      Esc - exactly the Esc -> pause menu -> Back to Game path - so the game
 *      goes on believing it owns a mouse the browser never gave it, and feeds
 *      raw *unlocked* movement to the camera. An unlocked cursor that runs into
 *      the window edge reports a movementX of a thousand pixels.
 *
 *   2. Movement that piles up behind a menu. PointerInputAbstraction adds every
 *      frame's delta to cursorDX, but only the in-world camera ever drains it
 *      (EntityRenderer, when inGameHasFocus). Whatever arrives while a screen is
 *      open - or while the game holds a lock it has not noticed yet - is spent
 *      in one frame on the way back into the world.
 *
 *   3. Bogus single-event jumps under a real lock. Chromium on Linux sometimes
 *      reports one mousemove of hundreds of pixels out of nowhere while the
 *      pointer is locked, and the first event after a lock engages can carry
 *      the distance from where the cursor was.
 *
 * What it does about them:
 *
 *   - A capture-phase mousemove listener on the canvas's container runs before
 *     the engine's own listener on the canvas (an ancestor's capture listener
 *     always does), and shadows movementX/Y on the event object. The engine is
 *     handed movement only when the browser really holds the lock on the game
 *     canvas, the game is in the world with no screen open, the lock has had a
 *     moment to settle, and the event is not a lone spike.
 *
 *   - A spike is held back, not thrown away at once: if the next event goes the
 *     same way it was the start of a real flick, and both are handed over
 *     together. A lone jump followed by ordinary movement is dropped.
 *
 *   - requestPointerLock is wrapped so we know when the game wants the mouse.
 *     If the browser refuses, we ask again with a backoff past Chrome's Esc
 *     cooldown - but only while the game is in the world, never behind a menu,
 *     and our own retries do not reset the retry budget.
 *
 * ?noguard=1 turns this file off, so the bug can be A/B'd in one browser.
 * window.mcMouseGuard.state() is posted with the telemetry stats, so a report
 * of a wild camera comes with numbers.
 */
(function () {
  'use strict';

  if (new URLSearchParams(location.search).get('noguard') === '1') {
    window.mcMouseGuard = {
      disabled: true,
      state: function () { return { disabled: true }; },
      simulateRefusal: function () {}
    };
    return;
  }

  const SETTLE_MS = 80;      // movement this soon after the lock engages is dropped
  const SPIKE_MIN = 250;     // px in one event before it can count as a spike
  const SPIKE_RATIO = 8;     // ... and this many times the recent average
  const SPIKE_HARD = 2500;   // no hand does this in one event (375 degrees)
  const AVG_TAU_MS = 150;    // how fast the recent average forgets
  const HOLD_MS = 100;       // a held spike must be confirmed within this
  const MAX_RETRIES = 8;

  const state = {
    wantsGrab: false,      // the game asked for the mouse and has not let go
    pointerLocked: false,  // the browser agrees
    passed: 0,             // events handed to the engine with movement
    suppressed: 0,         // zeroed: no pointer lock
    zeroedMenu: 0,         // zeroed: locked, but a screen is open
    settled: 0,            // zeroed: lock had only just engaged
    spikesDropped: 0,
    spikesConfirmed: 0,    // held, then turned out to be a real flick
    maxPassed: 0,
    maxSeen: 0,
    relockTries: 0,
    lockChanges: 0
  };
  const recentSpikes = [];   // last few dropped, for telemetry

  let canvas = null;
  let retryTimer = null;
  let retryDelay = 250;
  let lockedAt = -1e9;
  let settleNext = false;    // drop the first event after a lock engages
  let avg = 0, lastMoveT = 0;
  let held = null;           // a suspected spike waiting for the next event
  let lastRequestT = -1e9;
  let refuseUntil = 0;       // test hook: pretend the browser says no

  const noop = function () {};

  function gameCanvas() {
    // the engine can hand us a new canvas (context loss, resize), so never
    // trust a stale reference: a stale one would make every delta look like it
    // arrived unlocked, which would freeze the camera
    if (canvas && !canvas.isConnected) {
      const fresh = document.querySelector('#game canvas');
      if (fresh) attachCanvas(fresh);
    }
    return canvas;
  }

  function isGameCanvas(el) {
    if (!el || el.tagName !== 'CANVAS') return false;
    return el === canvas || !!(el.closest && el.closest('#game'));
  }

  function sync() {
    const c = gameCanvas();
    const was = state.pointerLocked;
    state.pointerLocked = !!c && document.pointerLockElement === c;
    if (was !== state.pointerLocked) state.lockChanges++;
    return state.pointerLocked;
  }

  /* In the world with no GUI screen open, from the engine's own screenChanged
   * hook (telemetry.js). Without that hook we cannot tell, so we do not block. */
  function inWorld() {
    try {
      const t = window.mcTelemetry;
      return !t || !t.screens().name;
    } catch (e) { return true; }
  }

  function clearRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function resetRetries() {
    clearRetry();
    state.relockTries = 0;
    retryDelay = 250;
  }

  /* Ask for the lock without going through our own wrapper, so a retry is not
   * mistaken for the game asking again (which would reset the budget and retry
   * forever). */
  function request(c, args) {
    lastRequestT = performance.now();
    if (lastRequestT < refuseUntil) {
      setTimeout(function () { document.dispatchEvent(new Event('pointerlockerror')); }, 0);
      return undefined;
    }
    return origLock.apply(c, args || []);
  }

  function retryRequest(c) {
    try {
      const p = request(c);
      if (p && typeof p.catch === 'function') p.catch(noop);
    } catch (e) { /* retried below */ }
  }

  /* The game asked for the mouse and the browser has not given it: ask again,
   * backing off until Chrome's Esc penalty expires. Never behind a menu - a
   * lock there only fights the menu, which lets go of it again. */
  function scheduleRetry() {
    if (retryTimer !== null || !state.wantsGrab || state.relockTries >= MAX_RETRIES) return;
    if (sync() || !inWorld()) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (!state.wantsGrab || sync() || !inWorld()) return;
      const c = gameCanvas();
      if (!c) return;
      state.relockTries++;
      retryRequest(c);
      retryDelay = Math.min(retryDelay * 2, 2000);
      setTimeout(function () { if (!sync()) scheduleRetry(); }, 150);
    }, retryDelay);
  }

  function shadow(evt, x, y) {
    try {
      Object.defineProperty(evt, 'movementX', { get: function () { return x; }, configurable: true });
      Object.defineProperty(evt, 'movementY', { get: function () { return y; }, configurable: true });
    } catch (e) { /* a frozen event object: nothing can be done to that one */ }
  }

  function dropSpike(s, why) {
    state.spikesDropped++;
    recentSpikes.push({ x: Math.round(s.x), y: Math.round(s.y), avg: Math.round(avg), why: why });
    if (recentSpikes.length > 8) recentSpikes.shift();
  }

  function pass(evt, x, y, dx, dy) {
    const mag = Math.hypot(x, y);
    avg += (mag - avg) * 0.3;
    state.passed++;
    if (mag > state.maxPassed) state.maxPassed = Math.round(mag);
    if (x !== dx || y !== dy) shadow(evt, x, y);
  }

  /* everything the engine's mousemove listener is about to read */
  function filterMove(evt) {
    if (Object.prototype.hasOwnProperty.call(evt, 'movementX')) return;
    const dx = evt.movementX || 0, dy = evt.movementY || 0;
    const mag = Math.hypot(dx, dy);
    if (mag > state.maxSeen) state.maxSeen = Math.round(mag);

    if (!sync()) {
      // the game may think it has the mouse but the browser does not: this is
      // the state that spins the camera, so try to heal it as we go
      held = null;
      if (state.wantsGrab) scheduleRetry();
      if (mag) { state.suppressed++; shadow(evt, 0, 0); }
      return;
    }
    if (!inWorld()) {
      // no screen uses movement, and anything let through here would only pile
      // up in cursorDX for the camera to spend in one frame later
      held = null;
      if (mag) { state.zeroedMenu++; shadow(evt, 0, 0); }
      return;
    }
    const now = performance.now();
    if (settleNext || now - lockedAt < SETTLE_MS) {
      settleNext = false;
      held = null;
      if (mag) { state.settled++; shadow(evt, 0, 0); }
      return;
    }
    if (!mag) return;

    avg *= Math.exp(-Math.max(0, now - lastMoveT) / AVG_TAU_MS);
    lastMoveT = now;

    if (mag > SPIKE_HARD) {
      if (held) dropSpike(held, 'lone');
      held = null;
      dropSpike({ x: dx, y: dy }, 'hard');
      shadow(evt, 0, 0);
      return;
    }
    if (held) {
      const h = held;
      held = null;
      if (now - h.t < HOLD_MS && dx * h.x + dy * h.y > 0 && mag >= 0.25 * h.mag) {
        // the big one was the start of a real flick: hand both over now
        state.spikesConfirmed++;
        pass(evt, dx + h.x, dy + h.y, dx, dy);
        return;
      }
      dropSpike(h, 'lone');
    }
    if (mag > SPIKE_MIN && mag > SPIKE_RATIO * avg) {
      held = { x: dx, y: dy, mag: mag, t: now };
      shadow(evt, 0, 0);
      return;
    }
    pass(evt, dx, dy, dx, dy);
  }

  function attachCanvas(c) {
    if (!c || c === canvas && c.__mcGuard) return;
    canvas = c;
    if (canvas.__mcGuard) return;
    canvas.__mcGuard = true;
    // capture on the container: an ancestor's capture listener always runs
    // before the target's own listener, whatever the registration order was
    (canvas.parentElement || document.body).addEventListener('mousemove', filterMove, true);
  }

  /* document-level watchers: installed once, they outlive any canvas */
  document.addEventListener('pointerlockchange', function () {
    held = null;
    if (sync()) {
      lockedAt = performance.now();
      settleNext = true;
      state.wantsGrab = true;
      resetRetries();
    } else {
      // the browser let go (Esc, focus loss): the engine pauses on its own when
      // it notices, so this is not a wish we should keep re-asserting
      state.wantsGrab = false;
      clearRetry();
    }
  }, true);

  document.addEventListener('pointerlockerror', function () {
    // the engine leaves its grabbed flag set on this path - that is bug 1
    if (state.wantsGrab) scheduleRetry();
  }, true);

  // A click on the game in the world is the user saying "take the mouse back".
  // The engine re-locks on its own for that (its canvas mousedown handler, and
  // Minecraft.runTick when it sees the button); only if nobody asked within a
  // moment do we ask ourselves, still inside the click's user activation.
  document.addEventListener('mousedown', function (evt) {
    if (sync() || !isGameCanvas(evt.target) || !inWorld()) return;
    const clickT = performance.now();
    setTimeout(function () {
      if (sync() || !inWorld() || lastRequestT >= clickT) return;
      const c = gameCanvas();
      if (!c) return;
      state.wantsGrab = true;
      resetRetries();
      retryRequest(c);
      setTimeout(function () { if (!sync()) scheduleRetry(); }, 150);
    }, 200);
  }, true);

  /* learn when the game wants the mouse, by wrapping the call it makes */
  const origLock = Element.prototype.requestPointerLock;
  Element.prototype.requestPointerLock = function () {
    if (!isGameCanvas(this)) return origLock.apply(this, arguments);
    if (this !== canvas) attachCanvas(this);
    state.wantsGrab = true;
    resetRetries();
    // the request may be refused; the engine does not retry, so we will
    setTimeout(function () { if (!sync()) scheduleRetry(); }, 150);
    return request(this, arguments);
  };

  const origExit = document.exitPointerLock.bind(document);
  document.exitPointerLock = function () {
    state.wantsGrab = false;   // the game let go on purpose
    clearRetry();
    return origExit();
  };

  window.mcMouseGuard = {
    state: function () {
      return Object.assign({}, state, {
        pointerLocked: sync(), inWorld: inWorld(), avg: Math.round(avg),
        recentSpikes: recentSpikes.slice()
      });
    },
    /* tests use this to make the browser refuse every lock request for `ms`,
     * the way Chrome does right after Esc */
    simulateRefusal: function (ms) { refuseUntil = performance.now() + (ms || 1500); },
    attach: attachCanvas
  };

  function findCanvas() {
    const c = document.querySelector('#game canvas');
    if (c) { attachCanvas(c); return true; }
    return false;
  }
  if (!findCanvas()) {
    const host = document.getElementById('game') || document.body;
    const mo = new MutationObserver(function () { if (findCanvas()) mo.disconnect(); });
    mo.observe(host, { childList: true, subtree: true });
    // and keep watching: the engine can recreate its canvas on a context loss
    setInterval(findCanvas, 2000);
  }
})();
