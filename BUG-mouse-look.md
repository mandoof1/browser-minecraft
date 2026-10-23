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

With the default sensitivity (0.5) `f1 == 1.0`, so one event carrying
`movementX = 1000` turns the view 1000 degrees (spinning), and one event with
`movementY = 1000` clamps pitch to ±90 (view locked fully up or fully down).
That is exactly the reported symptom.

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

A second, related dead end: the engine's click-to-relock path
(`platformInput.js:234`) only re-requests the lock **while `pointerLockFlag` is
still true**. If the engine has already un-grabbed, clicking the canvas never
gives mouse look back — the user has to alt-tab away and back.

## Fix, in the engine (two lines per target)

wasm-GC, `src/wasm-gc-teavm/js/platformInput.js:430`:

```js
document.addEventListener("pointerlockerror", function (evt) {
    pointerLockWaiting = false;
    pointerLockFlag = false;        // the browser said no: stop believing otherwise
});
```

and make the camera read the browser, not the flag —
`src/wasm-gc-teavm/js/platformInput.js:709`:

```js
inputImports["isMouseGrabbed"] = function () {
    return pointerLockFlag && document.pointerLockElement === canvasElement;
};
```

JS target, `src/teavm/java/net/lax1dude/eaglercraft/v1_8/internal/PlatformInput.java:676`
(add `pointerLockFlag = false;`) and `:1396`
(`return pointerLockFlag && isPointerLocked();`).

## Fix without touching the engine (what the port does now)

The engine is decompiled Minecraft and is not redistributed here, so the port
layer fixes it from outside: **`web/app/mouselook.js`** (loaded from
`web/index.html` before `boot.js`).

1. A **capture-phase `mousemove` listener on the canvas container** — an
   ancestor's capture listener always runs before the canvas's own listener —
   shadows `movementX`/`movementY` to `0` on the event object whenever
   `document.pointerLockElement !== canvas`. The engine then cannot feed
   unlocked movement to the camera, whatever its flag says.
2. Wraps `Element.prototype.requestPointerLock` to learn when the game *wants*
   the mouse, and re-requests it with a backoff (400 ms → 2 s, max 8 tries) when
   the browser disagrees — that walks past Chrome's post-Esc penalty instead of
   giving up.
3. On a click on the canvas while the game is in-world with no GUI screen open,
   it asks for the lock itself, which covers the "engine already un-grabbed, so
   its own click-to-relock path never runs" dead end.

Measured with `node tools/mouselook.mjs wasm` (headless Brave, real pointer
lock, real pointer-lock state):

| step | result |
|---|---|
| in world, lock engaged | engine handed real deltas (5-6 px/step), view changed 60-84 % |
| Esc -> pause menu -> Back to Game | lock re-engaged, `wantsGrab=true`, `pointerLocked=true` |
| lock dropped underneath the game, mouse jumped across the window | engine handed `{x:0,y:0}`, view changed **0.0-3.1 %** |
| click on the canvas afterwards | lock re-acquired, look works again |

Add `?noguard=1` to the URL to switch this file off and watch the same mouse
movement drive the camera with the raw deltas (that is the A/B for the bug).
