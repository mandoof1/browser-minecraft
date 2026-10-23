# BUG: mouse look snaps to full pitch / spins — where the bug is

Symptom (real browser, real mouse): the view snaps straight up or straight down,
or starts spinning, and the mouse feels "completely broken".

## Root cause

The engine keeps **its own flag** for "the game owns the mouse" and that flag can
disagree with the browser's actual pointer-lock state. While they disagree, the
game feeds **raw, unlocked `mousemove` deltas** into the camera.

### wasm-GC build (the default)

`src/wasm-gc-teavm/js/platformInput.js`

```js
82   var pointerLockFlag = false;          // "the game owns the mouse"
83   var pointerLockWaiting = false;

664  function mouseSetGrabbed(grab) {
666      pointerLockFlag = !!grab;         // set IMMEDIATELY
670      pointerLockWaiting = true;
672      canvasElement.requestPointerLock();   // may be REFUSED, and that is fine
     }

418  document.addEventListener("pointerlockchange", function (evt) {
419      window.setTimeout(function () {
420          const grab = (document.pointerLockElement === canvasElement);
426          pointerLockFlag = grab;       // flag is only revisited 60 ms later
         }, 60);
428      pointerLockWaiting = false;
     });

430  document.addEventListener("pointerlockerror", function (evt) {
431      pointerLockWaiting = false;       // <-- BUG: pointerLockFlag is NOT cleared
     });

709  inputImports["isMouseGrabbed"] = function () { return pointerLockFlag; };
```

`src/wasm-gc-teavm/java/net/lax1dude/eaglercraft/v1_8/internal/PlatformInput.java`

```java
406  case EVENT_MOUSE_MOVE: {
407      if (isMouseGrabbed()) {                 // trusts the stale flag
408          mouseDX += obj.getMovementX();      // raw unlocked movementX
409          mouseDY -= obj.getMovementY();
         }
```

### JavaScript build (`?build=js`) — same bug, different file

`src/teavm/java/net/lax1dude/eaglercraft/v1_8/internal/PlatformInput.java`

```java
370  if (pointerLockFlag) {                     // stale flag
371      mouseDX += evt.getMovementX();
372      mouseDY += -evt.getMovementY();
     }
...
673  win.getDocument().addEventListener("pointerlockerror", ... {
676      pointerLockWaiting = false;            // <-- pointerLockFlag never cleared
     });
...
1395 public static boolean isMouseGrabbed() { return pointerLockFlag; }
```

### Where the stale flag becomes a spinning camera

`src/main/java/net/lax1dude/eaglercraft/v1_8/PointerInputAbstraction.java`

```java
66   public static void runGameLoop() {
71       cursorX = oldMX = Mouse.getX();
73       cursorDX += Mouse.getDX();      // drains PlatformInput.mouseDX
74       cursorDY += Mouse.getDY();
```

`src/game/java/net/minecraft/util/MouseHelper.java`

```java
49   public void mouseXYChange() {
50       this.deltaX = PointerInputAbstraction.getVCursorDX();
51       this.deltaY = PointerInputAbstraction.getVCursorDY();
```

`src/game/java/net/minecraft/client/renderer/EntityRenderer.java`

```java
893  if (this.mc.inGameHasFocus && flag) {
895      this.mc.mouseHelper.mouseXYChange();
896      float f = this.mc.gameSettings.mouseSensitivity * 0.6F + 0.2F;
900      float f1 = f * f * f * 8.0F;
901      float f2 = (float) this.mc.mouseHelper.deltaX * f1;   // yaw
902      float f3 = (float) this.mc.mouseHelper.deltaY * f1;   // pitch
```

With the default sensitivity (0.5) `f1 == 1.0`, and `Entity.setAngles` turns
0.15 degrees per pixel. So one event carrying `movementX = 1000` turns the view
150 degrees, and one with `movementY = 600` takes pitch from level to straight
up or down (it clamps at ±90). A few of those in a row is a spin. That is
exactly the reported symptom.

## Why the flag goes stale in normal play

Without pointer lock, `evt.movementX/Y` is the OS cursor's movement, and a cursor
that hits a window edge and jumps reports deltas of hundreds to thousands of
pixels. The flag goes stale on the ordinary path:

1. `Esc` → pause menu → the browser exits pointer lock (Chrome penalises
   re-locking for ~1 s after Esc).
2. `Back to Game` → the game calls `mouseSetGrabbed(true)` →
   `pointerLockFlag = true` immediately, `requestPointerLock()` is **refused**
   → only `pointerlockerror` fires → line 431 clears `pointerLockWaiting` but
   leaves `pointerLockFlag = true`.
3. The game now believes it owns the mouse. The cursor is visible and free. The
   user moves it, the camera takes the raw deltas, and it snaps/spins.

The engine's canvas `mousedown` handler (`platformInput.js:234`) re-requests the
lock only while `pointerLockFlag` is still true, so in this stale state one click
on the game hands the mouse back. In the other state, where the engine has
already let go, a click in the world reaches `Minecraft.runTick`
(`Minecraft.java:1387`), and that path grabs the mouse again too.

## Two more ways the camera goes wild

The stale flag is not the whole story. After the first guard shipped, the camera
still went "wacky, everywhere". Two more causes:

### Movement piles up behind menus and gets spent in one frame

`PointerInputAbstraction.runGameLoop()` adds every frame's `Mouse.getDX()` to
`cursorDX`. Only `MouseHelper.mouseXYChange()` drains it, and that runs only
from `EntityRenderer` when `inGameHasFocus && Display.isActive()`.
`MouseHelper.grabMouseCursor()` zeroes its own `deltaX`, not `cursorDX`. So any
movement the engine accepts while a screen is open, or while it holds a lock the
game has not noticed yet, is kept, and the camera spends all of it in the first
frame back in the world.

One way in: the first guard kept its "the game wants the mouse" flag set after
Esc, and its retry called the wrapped `requestPointerLock`, which reset the
retry counter on every call. So it retried forever. Once the user clicked a
pause-menu button (a user gesture), it could grab the lock *inside the pause
menu*. The engine then took the movement, `GuiIngameMenu.updateScreen()` let go
of the lock again, and the pile-up was spent on Back to Game.

### Bogus single-event jumps under a real lock

Chromium on Linux sometimes delivers one `mousemove` with a movement of
hundreds of pixels while the pointer is locked. The first event after a lock
engages can also carry the distance from where the cursor was. Nothing in the
engine filters either.

## Fix, in the engine

Gate the movement where it enters the engine, and leave `isMouseGrabbed()`
alone. `Minecraft.java:1247` opens the pause menu on any tick where
`!Mouse.isMouseGrabbed()`, after a 6-tick grace period (`:1259`). So "fixing" the
flag itself by clearing it on `pointerlockerror`, or by having
`isMouseGrabbed()` read `document.pointerLockElement`, bounces the player back
to the pause menu whenever a lock request is refused or slow. It also turns off
the click-to-relock path at `platformInput.js:234`.

wasm-GC, `src/wasm-gc-teavm/js/platformInput.js:257`, the canvas `mousemove`
handler:

```js
const locked = (document.pointerLockElement === canvasElement);
pushEvent(EVENT_TYPE_INPUT, EVENT_INPUT_MOUSE, {
    ...
    "movementX": locked ? evt.movementX : 0,
    "movementY": locked ? evt.movementY : 0
});
```

JS target, `src/teavm/java/net/lax1dude/eaglercraft/v1_8/internal/PlatformInput.java:370`:
`if (pointerLockFlag && isPointerLockedImpl())`. Do not use
`isPointerLocked()` here: it returns true while `pointerLockWaiting` is set,
which is the "workaround for chrome bug" path.

For the pile-up, zero `PointerInputAbstraction.cursorDX/DY` in
`MouseHelper.grabMouseCursor()`. Spike filtering would need the same logic as
the port's guard below.

## Fix without touching the engine (what the port does now)

The engine is decompiled Minecraft and is not redistributed here, so the port
layer fixes all three from outside: **`web/app/mouselook.js`** (loaded from
`web/index.html` before `boot.js`).

1. A **capture-phase `mousemove` listener on the canvas container**. An
   ancestor's capture listener always runs before the canvas's own listener, so
   it can shadow `movementX`/`movementY` on the event object first. The engine
   is handed movement only when all of these hold:
   - the browser really holds the lock on the game canvas;
   - the game is in the world with no screen open (from the engine's own
     `screenChanged` hook), so nothing piles up behind a menu;
   - the lock engaged more than 80 ms ago, and this is not the first event
     after it engaged;
   - the event is not a lone spike: more than 250 px *and* more than 8x the
     recent average. A spike is held for one event. If the next one goes the
     same way, it was the start of a real flick and both are handed over
     together. Anything over 2500 px is always dropped.
2. Wraps `Element.prototype.requestPointerLock` to learn when the game *wants*
   the mouse. If the browser refuses, it asks again with a backoff (250 ms to
   2 s, max 8 tries) to get past Chrome's post-Esc penalty. It retries only
   while the game is in the world, never behind a menu. Its own retries bypass
   the wrapper, so they cannot reset the budget. When the browser drops the lock
   (Esc, focus loss), the wish is cleared: the engine pauses by design.
3. As a fallback, if a click on the game in the world has not produced a lock
   request within 200 ms, it asks itself, still inside the click's user
   activation.

`window.mcMouseGuard.state()` counts what was passed, zeroed and dropped, and
keeps the last few dropped spikes. It is posted with every telemetry stats
record (`mouse` field), so a report of a wild camera comes with numbers.

`node tools/mouselook.mjs wasm` (headless Brave, real pointer lock) walks
these steps: enter the world, look, Esc then Back to Game, Back to Game with
the browser refusing the lock (`mcMouseGuard.simulateRefusal(ms)`) while the
mouse jumps around, a lone 900 px jump under a real lock, a real 1020 px flick,
then a final look.

Add `?noguard=1` to the URL to switch this file off and watch the same mouse
movement drive the camera with the raw deltas (that is the A/B for the bug).
