/* mouselook.js - the port's mouse-look guard.
 *
 * Why this exists. It fixes a bug in the engine's browser input layer, and the
 * engine is not ours to patch:
 *
 *   platformInput.js keeps its own flag for "the game owns the mouse".
 *   mouseSetGrabbed(true) sets that flag immediately and then calls
 *   requestPointerLock(); a pointerlockchange revisits the flag 60 ms later,
 *   and the pointerlockerror handler clears only the *waiting* flag - never the
 *   grabbed one.
 *
 *   So when requestPointerLock() is refused - Chrome refuses it for about a
 *   second after the user pressed Esc, which is exactly the Esc -> pause menu
 *   -> Back to Game path - the game goes on believing it owns the mouse. While
 *   it believes that, every mousemove over the canvas is fed to the camera
 *   (PlatformInput: `if (isMouseGrabbed()) mouseDX += evt.movementX`). With no
 *   pointer lock the cursor runs into the window edge and jumps, and one jump
 *   reports a movementX of a thousand pixels. The camera snaps to full pitch or
 *   spins: "the mouse autolocks up/down or goes crazy".
 *
 * Two fixes, both from outside the engine:
 *
 *   1. Suppress the deltas. A capture-phase listener on the container runs
 *      before the engine's listener on the canvas, so the movement values can
 *      be shadowed on the event object before the engine reads them. Whenever
 *      the browser does not actually hold pointer lock, the engine gets 0.
 *
 *   2. Keep the game's wish and the browser's state in sync. Wrap
 *      requestPointerLock so we know when the game wants the mouse; if the
 *      browser is not locked while the game wants it, ask again with a backoff
 *      past Chrome's Esc cooldown. The engine's own click-to-relock path stays
 *      intact - this only closes the window where it gave up.
 */
(function () {
  'use strict';

  /* ?noguard=1 turns this file off, so the bug can be A/B'd in one browser */
  if (new URLSearchParams(location.search).get('noguard') === '1') {
    window.mcMouseGuard = {
      disabled: true,
      state: function () { return { disabled: true }; },
      simulateLostLock: function () {}
    };
    return;
  }

  const state = {
    wantsGrab: false,     // the game asked for the mouse
    pointerLocked: false, // the browser agrees
    suppressed: 0,        // mousemove deltas zeroed because the two disagreed
    relockTries: 0,
    lockChanges: 0
  };

  let canvas = null;
  let retryTimer = null;
  let retryDelay = 400;

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

  function locked() {
    const c = gameCanvas();
    return !!c && document.pointerLockElement === c;
  }

  function sync() {
    const was = state.pointerLocked;
    state.pointerLocked = locked();
    if (was !== state.pointerLocked) state.lockChanges++;
    return state.pointerLocked;
  }

  function clearRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /* The game wants the mouse and the browser is not holding it: ask again,
   * backing off until Chrome's Esc penalty expires. */
  function scheduleRetry() {
    if (retryTimer !== null || !state.wantsGrab || sync()) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (!state.wantsGrab || sync()) { retryDelay = 400; return; }
      const c = gameCanvas();
      if (!c) return;
      state.relockTries++;
      try {
        const p = c.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(function () { /* retried below */ });
      } catch (e) { /* retried below */ }
      retryDelay = Math.min(retryDelay * 2, 2000);
      if (state.relockTries < 8) scheduleRetry();
      else retryDelay = 400;
    }, retryDelay);
  }

  /* 1. zero the deltas the engine would otherwise feed to the camera */
  function filterMove(evt) {
    if (sync()) return;
    if (state.wantsGrab) {
      // the game thinks it has the mouse but the browser does not: this is the
      // exact state that spins the camera, so try to heal it as we go
      scheduleRetry();
    }
    if (evt.movementX === 0 && evt.movementY === 0) return;
    if (Object.prototype.hasOwnProperty.call(evt, 'movementX')) return;
    try {
      Object.defineProperty(evt, 'movementX', { get: function () { return 0; }, configurable: true });
      Object.defineProperty(evt, 'movementY', { get: function () { return 0; }, configurable: true });
      state.suppressed++;
    } catch (e) { /* a frozen event object: nothing can be done to that one */ }
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
    sync();
    // the engine re-reads its own flag 60 ms after a change; mirror that so
    // "wantsGrab" and what the game believes stay comparable
    setTimeout(function () { sync(); if (state.wantsGrab) scheduleRetry(); }, 80);
  }, true);

  document.addEventListener('pointerlockerror', function () {
    // the engine leaves its grabbed flag set on this path - that is the bug
    sync();
    if (state.wantsGrab) scheduleRetry();
  }, true);

  // a click on the game is the user saying "take the mouse back". The engine
  // only re-locks on click while it still believes it holds the mouse, so when
  // it has already given up (its pointerlockchange path) mouse look would stay
  // dead until the window was refocused - which nobody does. If the game is in
  // the world with no GUI screen open, ask for the lock ourselves.
  function inWorldNoGui() {
    try {
      return !!(window.mcTelemetry && !window.mcTelemetry.screens().name);
    } catch (e) { return false; }
  }

  document.addEventListener('mousedown', function (evt) {
    if (sync()) return;
    if (!isGameCanvas(evt.target)) return;
    if (state.wantsGrab) { scheduleRetry(); return; }
    if (inWorldNoGui()) {
      state.wantsGrab = true;
      state.relockTries = 0;
      retryDelay = 400;
      clearRetry();
      const c = gameCanvas();
      if (c) {
        try {
          const p = c.requestPointerLock();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (e) {}
        setTimeout(function () { sync(); if (!state.pointerLocked) scheduleRetry(); }, 120);
      }
    }
  }, true);

  /* 2. learn when the game wants the mouse, by wrapping the call it makes */
  const origLock = Element.prototype.requestPointerLock;
  Element.prototype.requestPointerLock = function () {
    const mine = isGameCanvas(this);
    const r = origLock.apply(this, arguments);
    if (mine) {
      if (isGameCanvas(this) && this !== canvas) attachCanvas(this);
      state.wantsGrab = true;
      state.relockTries = 0;
      retryDelay = 400;
      clearRetry();
      // the request may be refused; the engine does not retry, so we will
      setTimeout(function () { sync(); if (!state.pointerLocked) scheduleRetry(); }, 120);
    }
    return r;
  };

  const origExit = document.exitPointerLock.bind(document);
  document.exitPointerLock = function () {
    if (state.pointerLocked) state.wantsGrab = false; // the game let go on purpose
    clearRetry();
    return origExit();
  };

  window.mcMouseGuard = {
    state: function () { return Object.assign({}, state, { pointerLocked: sync() }); },
    /* tests use this to pretend the browser dropped the lock underneath us */
    simulateLostLock: function () {
      const c = gameCanvas();
      if (c && document.pointerLockElement === c) origExit();
      state.wantsGrab = true;
      scheduleRetry();
    },
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
