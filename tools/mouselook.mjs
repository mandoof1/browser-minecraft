/* mouselook.mjs - what the game actually believes about the mouse, and whether
 * the port's guard keeps that belief honest.
 *
 *   node tools/mouselook.mjs [wasm|js]
 *
 * The engine's input layer (platformInput.js) sets its "I own the mouse" flag
 * when it *asks* for pointer lock, revisits it 60 ms after a pointerlockchange,
 * and its pointerlockerror handler clears the waiting flag but not the grabbed
 * one. So a refused requestPointerLock() - Chrome refuses for about a second
 * after the user pressed Esc, which is exactly the Esc -> pause menu -> Back to
 * Game path - leaves the game reading raw unlocked mousemove deltas as camera
 * input. One cursor jump across a window reports a movementX of ~1000 px, and
 * the view snaps to full pitch or spins.
 *
 * This test walks the real user path and measures each step:
 *   1. enter a world            -> the game grabs the mouse, lock is on
 *   2. look with the mouse      -> the engine must be handed real deltas
 *   3. Esc, Back to Game        -> the game lets go, then grabs again
 *   4. Back to Game refused     -> deltas must be zeroed for the engine, and
 *                                  the lock must come back without a click
 *   5. a lone jump, a flick     -> the jump is dropped, the flick gets through
 *   6. look again               -> mouse look still works
 */
import { startServer, launch, activate, watchPage, sleep, waitFor, shot, report, imgdiff } from './harness.mjs';

const BUILD = process.argv[2] || 'wasm';
const PORT = Number(process.env.PORT || 8776);
const URL = `http://127.0.0.1:${PORT}/?build=${BUILD}&theater=1`;

const server = startServer(PORT);
await sleep(900);
const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const problems = [], notes = [];
watchPage(page, problems, { ignore: [/empty soundEvent/, /favicon/, /AudioContext/, /Autoplay/, /SwiftShader/, /GroupMarkerNotSet/, /wss:\/\/relay\./] });

await page.evaluateOnNewDocument(`(() => {
  window.__lock = { requests: [], errors: [], changes: [] };
  const L = window.__lock;
  const canvas = () => document.querySelector('#game canvas');
  const orig = Element.prototype.requestPointerLock;
  Element.prototype.requestPointerLock = function (...a) {
    L.requests.push({ t: Math.round(performance.now()), onCanvas: this === canvas() });
    try {
      const r = orig.apply(this, a);
      if (r && r.then) r.then(() => {}, () => L.errors.push({ t: Math.round(performance.now()), why: 'rejected' }));
    } catch (e) { L.errors.push({ t: Math.round(performance.now()), why: String(e && e.message || e) }); }
  };
  document.addEventListener('pointerlockchange', () => {
    L.changes.push({ t: Math.round(performance.now()), grab: document.pointerLockElement === canvas() });
  }, true);
  document.addEventListener('pointerlockerror', () => {
    L.errors.push({ t: Math.round(performance.now()), why: 'pointerlockerror' });
  }, true);
})()`);

const mark = m => notes.push('  [' + Math.round((Date.now() - t0) / 1000) + 's] ' + m);
let t0 = Date.now();
const guard = () => page.evaluate('window.mcMouseGuard.state()');
const screenName = async () => String((await page.evaluate('window.mcTelemetry.screens()')).name || 'null');
let geom = { w: 427, h: 267, rw: 1280, rh: 800 };
const refresh = async () => {
  const s = await page.evaluate(`(window.mcTelemetry.events().filter(e=>e.kind=='screen').slice(-1)[0]||{}).detail`);
  if (s && s.w) geom = s;
};
const box = async () => page.$eval('#game canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const gcx = () => geom.w / 2;
async function clickGUI(gx, gy, label) {
  await refresh();
  const bb = await box();
  const px = bb.x + gx * (geom.rw / geom.w), py = bb.y + gy * (geom.rh / geom.h);
  await page.mouse.move(px, py); await sleep(120);
  await page.mouse.down(); await sleep(180); await page.mouse.up();
  mark('click ' + label + ' at page(' + Math.round(px) + ',' + Math.round(py) + ')');
  await sleep(700);
}
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await sleep(20000);
    const n = await screenName();
    if (/GuiGameOver/.test(n)) { mark('the player fell before the ground loaded, respawning'); await clickGUI(gcx() - 25, geom.h / 4 + 106, 'Respawn'); continue; }
    mark('in world, screen=' + n);
    return n;
  }
  return await screenName();
};

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitFor(page, 'window.mcBoot && window.mcBoot.done === true', 90000, 'handover');
  await activate(page);
  await waitFor(page, 'window.mcBoot.canvasSeen === true', 120000, 'canvas');
  await sleep(3000);

  async function waitScreen(re, label, timeout = 40000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const s = await page.evaluate(`(() => { const e = window.mcTelemetry.events().filter(x=>x.kind=='screen').pop(); return e ? e.detail : null; })()`);
      if (s && re.test(String(s.name || 'null'))) { await refresh(); return s; }
      await sleep(400);
    }
    throw new Error('timeout waiting for ' + label);
  }

  for (let i = 0; i < 8; i++) {
    const s = await waitScreen(/ContentWarning|EditProfile|DefaultUsernameNote|GuiMainMenu/, 'a boot screen');
    const name = String(s.name);
    if (/GuiMainMenu/.test(name)) break;
    if (/ContentWarning/.test(name)) await clickGUI(gcx() - 25, geom.h / 6 + 148, 'content warning: Done');
    else if (/EditProfile/.test(name)) {
      await clickGUI(gcx() + 50, geom.h / 6 + 35, 'profile username field');
      await page.keyboard.type('mouselook', { delay: 25 });
      await clickGUI(gcx() - 25, geom.h / 6 + 178, 'profile: Done');
    } else if (/DefaultUsernameNote/.test(name)) await clickGUI(gcx() - 25, geom.h / 6 + 182, 'username note: ok');
    await sleep(500);
  }
  if (!/MainMenu/.test((await screenName()) || '')) problems.push('never reached the title screen: ' + await screenName());

  await clickGUI(gcx() - 25, geom.h / 4 + 58, 'Singleplayer');
  await waitScreen(/SelectWorld/, 'world list');
  await clickGUI(gcx() + 79, geom.h - 42, 'Create New World');
  await waitScreen(/CreateWorldSelection/, 'create-world choice');
  await clickGUI(gcx() - 25, geom.h / 4 + 50, 'Create (new world)');
  await waitScreen(/GuiCreateWorld/, 'create world screen');
  await clickGUI(gcx(), 70, 'world name field');
  for (let i = 0; i < 20; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('mouselookworld', { delay: 25 });
  await clickGUI(gcx() - 80, geom.h - 18, 'Create New World (confirm)');
  await waitFor(page, "window.mcTelemetry.logTail(600).join('\\n').match(/Preparing start region|Setting user|Starting integrated/)", 180000, 'world load');
  await settle();

  // what the engine is handed: a capture listener on the canvas runs after the
  // guard's capture listener on the container, i.e. after any filtering
  await page.evaluate(`(() => {
    const c = document.querySelector('#game canvas');
    window.__seen = [];
    c.addEventListener('mousemove', (e) => {
      window.__seen.push({ x: Math.round(e.movementX), y: Math.round(e.movementY),
                            locked: document.pointerLockElement === c });
      if (window.__seen.length > 300) window.__seen.shift();
    }, true);
  })()`);

  // ---- 1. in world: the game owns the mouse ----
  let g = await guard();
  mark('1. in world: ' + JSON.stringify(g) + ' lockRequests=' +
       JSON.stringify((await page.evaluate('window.__lock')).requests.slice(-2)));
  if (!g.pointerLocked) problems.push('pointer lock is not engaged in-world');
  if (!g.wantsGrab) problems.push('the guard did not notice the game asking for the mouse');

  // ---- 2. a real look, with the lock engaged ----
  const bb1 = await box();
  const before = await shot(page, 'mouselook-1-before.png');
  const lx = bb1.x + bb1.w / 2, ly = bb1.y + bb1.h / 2;
  await page.mouse.move(lx, ly);
  for (let i = 0; i < 12; i++) { await page.mouse.move(lx + (i + 1) * 30, ly - i * 6, { steps: 5 }); await sleep(40); }
  await sleep(1200);
  const seen1 = await page.evaluate('window.__seen.slice(-20)');
  const after = await shot(page, 'mouselook-2-looked.png');
  const realDeltas = seen1.filter(m => Math.abs(m.x) > 3 || Math.abs(m.y) > 3);
  mark('2. look: ' + realDeltas.length + ' real deltas reached the engine, e.g. ' + JSON.stringify(seen1.slice(-4)));
  mark('   view changed by ' + (await imgdiff(before, after)).toFixed(1) + '%');
  if (!realDeltas.length) problems.push('mouse look is dead: the engine never got a real delta');

  // ---- 3. Esc -> pause menu -> Back to Game: the path where Chrome refuses
  // the re-lock (it penalises re-locking for ~1 s after Esc), which is how the
  // engine ends up believing it owns a mouse the browser never gave it
  await page.keyboard.press('Escape');
  await sleep(2500);
  g = await guard();
  mark('3. after Esc: screen=' + (await screenName()) + ' ' + JSON.stringify(g));
  if (g.pointerLocked) problems.push('Esc left the pointer locked');
  if (g.wantsGrab) problems.push('the game still claims the mouse while the pause menu is open');
  await shot(page, 'mouselook-3-pause.png');

  // GuiIngameMenu lays its buttons out at height/4 + 24 - 16, so "Back to
  // Game" is centred at (w/2, h/4 + 18) in the game's own GUI space
  await clickGUI(gcx(), geom.h / 4 + 18, 'Back to Game');
  let regained = false;
  for (let i = 0; i < 14 && !regained; i++) { await sleep(500); regained = (await guard()).pointerLocked; }
  g = await guard();
  const L = await page.evaluate('window.__lock');
  mark('   after Back to Game: screen=' + (await screenName()) + ' ' + JSON.stringify(g) +
       ' errors=' + JSON.stringify(L.errors.slice(-3)));
  if (/IngameMenu/.test(await screenName())) problems.push('the Back to Game click did not close the pause menu');
  if (!regained) problems.push('pointer lock never came back after Back to Game (' +
    JSON.stringify(L.errors.slice(-3)) + ', ' + g.relockTries + ' guard retries)');

  // ---- 4. the refused re-lock: the exact state that spins the camera ----
  // Esc again, make the browser refuse lock requests the way Chrome does right
  // after Esc, and click Back to Game inside that window. The engine sets its
  // grabbed flag, the request fails, and pointerlockerror leaves the flag set:
  // the game is in the world, believes it owns the mouse, and the cursor is free.
  await page.keyboard.press('Escape');
  await sleep(2500);
  await page.evaluate('window.mcMouseGuard.simulateRefusal(3000)');
  await clickGUI(gcx(), geom.h / 4 + 18, 'Back to Game, with the browser refusing the lock');
  g = await guard();
  mark('4. refused re-lock: screen=' + (await screenName()) + ' ' + JSON.stringify(g));
  if (g.pointerLocked) problems.push('the simulated refusal did not keep the lock off');
  if (!g.wantsGrab) problems.push('the guard did not notice the game asking for the mouse after Back to Game');

  // move the mouse the way a user does when the cursor is free: big jumps, and
  // each one reports a huge movement delta - exactly what spins the camera
  const bb2 = await box();
  const frozen0 = await shot(page, 'mouselook-4-before-wild.png');
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(bb2.x + 25 + (i % 2) * (bb2.w - 50), bb2.y + 40 + i * 45);
    await sleep(70);
  }
  await sleep(300);
  const frozen1 = await shot(page, 'mouselook-5-after-wild.png');
  const seen2 = await page.evaluate('window.__seen.slice(-60)');
  const unlocked = seen2.filter(m => !m.locked);
  g = await guard();
  mark('   deltas handed to the engine while unlocked: ' + JSON.stringify(unlocked.slice(0, 8)));
  if (unlocked.some(m => m.x !== 0 || m.y !== 0))
    problems.push('the engine got non-zero movement deltas with no pointer lock: ' +
      JSON.stringify(unlocked.find(m => m.x !== 0 || m.y !== 0)));
  if (!g.suppressed) problems.push('the guard suppressed nothing - its listener is not in front of the engine\'s');
  const wild = await imgdiff(frozen0, frozen1);
  mark('   view changed by ' + wild.toFixed(1) + '% while the mouse jumped around unlocked');
  if (wild > 25) problems.push('the camera still moved while the browser had no pointer lock (' + wild.toFixed(1) + '% of the view changed)');

  // the guard keeps asking, so the lock comes back without another click
  let back = false;
  for (let i = 0; i < 16 && !back; i++) { await sleep(500); back = (await guard()).pointerLocked; }
  g = await guard();
  mark('   lock came back on its own=' + back + ' after ' + g.relockTries + ' guard retries');
  if (!back) problems.push('pointer lock never came back after the refusal window (' + g.relockTries + ' guard retries)');

  // ---- 5. a lone jump under a real lock, then a real flick ----
  const bb3 = await box();
  const sx = bb3.x + 60, sy = bb3.y + bb3.h / 2;
  await page.mouse.move(sx, sy); await sleep(150);
  for (let i = 1; i <= 10; i++) { await page.mouse.move(sx + i * 6, sy); await sleep(30); }
  const spikes0 = (await guard()).spikesDropped;
  await page.evaluate('window.__seen = []');
  await page.mouse.move(sx + 60 + 900, sy); await sleep(30);      // the jump
  for (let i = 1; i <= 10; i++) { await page.mouse.move(sx + 960 + i * 6, sy); await sleep(30); }
  await sleep(200);
  const seen3 = await page.evaluate('window.__seen.slice()');
  g = await guard();
  mark('5. lone 900 px jump: engine got ' + JSON.stringify(seen3.map(m => m.x)) + ' spikes dropped=' + (g.spikesDropped - spikes0));
  if (seen3.some(m => Math.abs(m.x) > 300)) problems.push('a lone 900 px jump reached the engine');
  if (g.spikesDropped <= spikes0) problems.push('the guard did not drop the lone jump');

  const fx = bb3.x + 80;
  await page.mouse.move(fx, sy); await sleep(300);
  for (let i = 1; i <= 5; i++) { await page.mouse.move(fx + i * 4, sy); await sleep(30); }
  await page.evaluate('window.__seen = []');
  for (let i = 1; i <= 3; i++) { await page.mouse.move(fx + 20 + i * 260, sy); await sleep(40); }
  for (let i = 1; i <= 3; i++) { await page.mouse.move(fx + 800 + i * 80, sy); await sleep(40); }
  await sleep(200);
  const flick = await page.evaluate('window.__seen.reduce((a, m) => a + m.x, 0)');
  mark('   real flick of 1020 px: engine got ' + flick + ' px');
  if (flick < 0.8 * 1020) problems.push('a real 1020 px flick was cut down to ' + flick + ' px');

  // ---- 6. and the look still works after all of that ----
  const r0 = await shot(page, 'mouselook-6-relocked.png');
  for (let i = 0; i < 10; i++) { await page.mouse.move(bb3.x + bb3.w / 2 - (i + 1) * 30, bb3.y + bb3.h / 2 + i * 6, { steps: 5 }); await sleep(40); }
  await sleep(1200);
  const r1 = await shot(page, 'mouselook-7-looked-again.png');
  const d = await imgdiff(r0, r1);
  mark('6. look after all of that changed the view by ' + d.toFixed(1) + '%');
  if (d < 15) problems.push('mouse look did not recover after the lock came back');
  await shot(page, 'mouselook-7-final.png');

  report('mouselook ' + BUILD, problems, notes);
} catch (e) {
  problems.push(String(e && e.message || e));
  try { notes.push('log tail: ' + (await page.evaluate('window.mcTelemetry.logTail(12)')).join(' | ').slice(0, 800)); } catch (e2) {}
  report('mouselook ' + BUILD, problems, notes);
} finally {
  await browser.close();
  server.kill();
}
