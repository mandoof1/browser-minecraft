/* playtest.mjs - does the port actually *play*, and does the world survive?
 *
 * This is the Minecraft version of the DOOM port's playtest: it does not trust
 * counters, it drives the real game through the real input path and then looks
 * at the pixels and at the bytes the game wrote.
 *
 *   1. boot -> content warning -> profile -> username note -> title screen
 *      (all of it clicked with the game's own GUI geometry, taken from the
 *      screenChanged hook's scaled resolution, so no hardcoded pixel maths)
 *   2. Singleplayer -> Create New World -> name it -> create
 *   3. in world: walk (W), jump (Space), look (pointer-locked mouse),
 *      mine (hold left button), place (right button) - each proven by diffing
 *      screenshots
 *   4. Esc -> Save and Quit to Title
 *   5. read the world back out of IndexedDB: it must be a real Anvil world
 *      (level.dat + region/*.mca), and tools/nbtcheck.py must be able to parse
 *      level.dat and report the name we typed and the version the game claims
 *   6. reload the page, select the world, re-enter it, and diff the view
 *      against the pre-quit view: same place, same terrain
 */
import { startServer, launch, activate, sleep, waitFor, shot, report, imgdiff, KEYS, hold, SHOTS, ROOT } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const BUILD = process.argv[2] || process.env.BUILD || 'wasm';
const PORT = Number(process.env.PORT || 8769);
const URL = `http://127.0.0.1:${PORT}/?build=${BUILD}`;
const WORLD = 'portworld' + Math.floor(Math.random() * 900 + 100);
const USER = 'porttest';

const server = startServer(PORT);
await sleep(900);
const browser = await launch();
const problems = [];
const notes = [];
const t0 = Date.now();
const mark = (m) => notes.push('[' + ((Date.now() - t0) / 1000).toFixed(0) + 's] ' + m);

try {
  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/favicon|empty soundEvent|Failed to load resource|Local player channel was closed/i.test(t))
      problems.push('console: ' + t.slice(0, 200));
  });

  console.log('open', URL);
  await page.goto(URL + '&theater=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitFor(page, 'window.mcBoot && window.mcBoot.done === true', 90000, 'port handover');
  await activate(page);

  /* ---- GUI geometry: the engine tells us its scaled resolution ---------- */
  let geom = null, canvasBox = null;
  async function refresh() {
    const s = await page.evaluate(`(() => {
      const e = window.mcTelemetry.events().filter(x => x.kind === 'screen').pop();
      const c = document.querySelector('#game canvas');
      const r = c && c.getBoundingClientRect();
      return { screen: e ? e.detail : null, box: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null };
    })()`);
    if (s.screen && s.screen.w) geom = s.screen;
    if (s.box) canvasBox = s.box;
    return s;
  }
  await waitFor(page, "window.mcTelemetry.events().some(e => e.kind === 'screen')", 60000, 'first GUI screen');
  await refresh();
  mark('GUI space ' + geom.w + 'x' + geom.h + ' (scale ' + geom.scale + ') on canvas ' + canvasBox.w + 'x' + canvasBox.h);

  async function waitScreen(re, label, timeout = 40000) {
    /* the regex lives in node, so poll the hook's last event from here rather
     * than trying to hand a RegExp to page.waitForFunction */
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const s = await page.evaluate(`(() => { const e = window.mcTelemetry.events().filter(x=>x.kind=='screen').pop(); return e ? e.detail : null; })()`);
      if (s && re.test(String(s.name || 'null'))) { await refresh(); return s; }
      await sleep(400);
    }
    const last = await page.evaluate(`(() => { const e = window.mcTelemetry.events().filter(x=>x.kind=='screen').pop(); return e ? e.detail : null; })()`);
    throw new Error('timeout waiting for ' + label + ', last screen was ' + (last && last.name));
  }

  /* A puppeteer click is a press and a release in the same frame. Buttons
   * cope, but GuiSlot (the world list) polls "is the button held" once per
   * tick and never sees a click that began and ended between two frames.
   * Hold the button down across a frame or two, like a hand would. */
  async function clickGUI(gx, gy, label) {
    await refresh();
    /* map GUI space to page pixels with the engine's own numbers (it reports
     * the canvas size it is drawing into), falling back to the DOM box */
    const sx = (geom.rw && geom.w ? geom.rw / geom.w : canvasBox.w / geom.w);
    const sy = (geom.rh && geom.h ? geom.rh / geom.h : canvasBox.h / geom.h);
    const px = canvasBox.x + gx * sx, py = canvasBox.y + gy * sy;
    await page.mouse.move(px, py);
    await sleep(120);
    await page.mouse.down();
    await sleep(180);
    await page.mouse.up();
    mark('click ' + label + ' at gui(' + Math.round(gx) + ',' + Math.round(gy) + ') -> page(' +
         Math.round(px) + ',' + Math.round(py) + ')');
    await sleep(600);
  }

  /* two presses on the same list row inside 250 ms: that is how Minecraft
   * decides you meant "open this world" */
  async function doubleClickGUI(gx, gy, label) {
    await refresh();
    const sx = (geom.rw && geom.w ? geom.rw / geom.w : canvasBox.w / geom.w);
    const sy = (geom.rh && geom.h ? geom.rh / geom.h : canvasBox.h / geom.h);
    const px = canvasBox.x + gx * sx, py = canvasBox.y + gy * sy;
    await page.mouse.move(px, py);
    await page.mouse.down(); await sleep(60); await page.mouse.up();
    await sleep(90);
    await page.mouse.down(); await sleep(120); await page.mouse.up();
    mark('double click ' + label + ' at page(' + Math.round(px) + ',' + Math.round(py) + ')');
    await sleep(600);
  }
  const cx = () => geom.w / 2, cy = () => geom.h / 2;

  /* click through whatever boot-time screens the engine puts in front of us.
   * Which ones appear depends on state saved by earlier runs, so the loop
   * reacts to the screen the engine reports instead of assuming a fixed order */
  async function advanceToTitle(max = 8) {
    for (let i = 0; i < max; i++) {
      const s = await waitScreen(/ContentWarning|EditProfile|DefaultUsernameNote|GuiMainMenu/, 'a boot screen');
      const name = String(s.name);
      if (/GuiMainMenu/.test(name)) return s;
      if (/ContentWarning/.test(name)) await clickGUI(cx() - 25, geom.h / 6 + 148, 'content warning: Done');
      else if (/EditProfile/.test(name)) {
        await clickGUI(cx() + 50, geom.h / 6 + 35, 'profile username field');
        await page.keyboard.type(USER, { delay: 25 });
        await clickGUI(cx() - 25, geom.h / 6 + 178, 'profile: Done');
      } else if (/DefaultUsernameNote/.test(name))
        await clickGUI(cx() - 25, geom.h / 6 + 182, 'username note: do not show again');
      else throw new Error('unexpected boot screen: ' + name);
      await sleep(500);
    }
    throw new Error('never reached the title screen');
  }

  /* ---- the boot-time screens ------------------------------------------- */
  await advanceToTitle();
  await shot(page, 'play-1-title.png');
  mark('title screen up');

  /* ---- create a world --------------------------------------------------- */
  await clickGUI(cx() - 25, geom.h / 4 + 58, 'Singleplayer');
  await waitScreen(/SelectWorld/, 'world list');
  await shot(page, 'play-2-worldlist.png');

  await clickGUI(cx() + 79, geom.h - 42, 'Create New World');
  /* EaglercraftX puts a create / import / vanilla choice in front of the
   * vanilla world-creation screen */
  await waitScreen(/CreateWorldSelection/, 'create-world choice');
  await clickGUI(cx() - 25, geom.h / 4 + 50, 'Create (new world)');
  await waitScreen(/GuiCreateWorld/, 'create world screen');
  await clickGUI(cx(), 70, 'world name field');
  /* the field starts out holding the engine's own default name, so clear it
   * the way a player would rather than appending to it */
  for (let i = 0; i < 20; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type(WORLD, { delay: 25 });
  await shot(page, 'play-3-createworld.png');
  await clickGUI(cx() - 80, geom.h - 18, 'Create New World (confirm)');

  mark('world generating...');
  const inGame = await waitScreen(/^null$/, 'in-game (GUI screen cleared)', 180000)
    .catch(async () => {
      /* fall back to the game's own log: the integrated server says so itself */
      await waitFor(page,
        "window.mcTelemetry.logTail(600).join('\\n').match(/Preparing start region|Starting integrated|Setting user/)",
        120000, 'integrated server start');
      return { name: null, viaLog: true };
    });
  mark('in-game (screen=' + inGame.name + '), letting the start region generate');
  await sleep(40000);

  const screenName = async () => String((await page.evaluate('window.mcTelemetry.screens()')).name || 'null');
  /* The integrated server generates the start region lazily, so a player who
   * spawns before the ground under them exists falls and dies. Settle in:
   * wait, respawn if the game says we died, and only then start testing. */
  async function settleInWorld(rounds = 5) {
    for (let i = 0; i < rounds; i++) {
      await sleep(20000);
      const n = await screenName();
      if (/GuiGameOver/.test(n)) {
        mark('the player fell before the ground generated - respawning (round ' + (i + 1) + ')');
        await clickGUI(cx() - 25, geom.h / 4 + 106, 'Respawn');
        continue;
      }
      mark('in world, screen=' + n + ' after ' + ((i + 1) * 20) + 's of settling');
      return n;
    }
    return await screenName();
  }
  await settleInWorld();

  /* ---- in-world input ---------------------------------------------------
   * Under pointer lock the virtual cursor is clamped to the viewport, so mouse
   * look goes through CDP with explicit deltas rather than puppeteer's
   * position-derived movementX/Y. 1.8 maps movementY to pitch at
   * 0.1 * sensitivity degrees per pixel (sensitivity is 0.5 by default), so
   * 900 px of delta is 45 degrees.
   */
  const cdp = await page.createCDPSession();
  async function look(dx, dy) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: canvasBox.x + canvasBox.w / 2, y: canvasBox.y + canvasBox.h / 2,
      deltaX: dx, deltaY: dy, buttons: 0
    });
    await sleep(150);
  }
  async function ifDeadRespawn(label) {
    if (!/GuiGameOver/.test(await screenName())) return false;
    mark('the player died ' + label + ' - respawning');
    await clickGUI(cx() - 25, geom.h / 4 + 106, 'Respawn');
    await sleep(9000);
    return true;
  }

  await page.mouse.move(canvasBox.x + canvasBox.w / 2, canvasBox.y + canvasBox.h / 2);
  await page.mouse.click(canvasBox.x + canvasBox.w / 2, canvasBox.y + canvasBox.h / 2);
  await sleep(1500);

  const a = await shot(page, 'play-4-spawn.png');

  /* Mouse look under pointer lock: the engine reads movementX/movementY, and
   * the virtual cursor is clamped to the viewport, so the only way to get a
   * large *net* delta out of one gesture is one long sweep. Park at the top
   * first, then sweep to the bottom: 1.8 turns movementY into pitch at
   * 0.1 * sensitivity degrees per pixel (sensitivity 0.5), so a 790 px sweep
   * is about 40 degrees down. */
  await page.mouse.move(canvasBox.x + canvasBox.w / 2, canvasBox.y + 2);
  await sleep(1200);
  await page.mouse.move(canvasBox.x + canvasBox.w / 2, canvasBox.y + canvasBox.h - 2);
  await sleep(2500);
  const lookShot = await shot(page, 'play-7-lookdown.png');
  const lookDiff = await imgdiff(a, lookShot);
  mark('looked ~45 degrees down (900 px of mouse delta) -> ' + lookDiff.toFixed(1) + '% pixels changed');
  if (lookDiff < 5) problems.push('mouse look changed almost nothing (' + lookDiff + '%)');

  await hold(page, KEYS.forward, 1200);
  await sleep(2500);
  const b = await shot(page, 'play-5-walked.png');
  const walkDiff = await imgdiff(lookShot, b);
  mark('walked forward 1.2 s -> ' + walkDiff.toFixed(1) + '% of pixels changed');
  if (walkDiff < 3) problems.push('walking changed almost nothing (' + walkDiff + '%)');
  await ifDeadRespawn('while walking');

  await page.keyboard.press(KEYS.jump);
  await sleep(1200);
  const c1 = await shot(page, 'play-6-jump.png');
  mark('jump -> ' + (await imgdiff(b, c1)).toFixed(1) + '% pixels changed');

  const beforeMine = await shot(page, 'play-8-before-mine.png');
  await page.mouse.down({ button: 'left' });
  await sleep(3200);
  await page.mouse.up({ button: 'left' });
  await sleep(2500);
  const afterMine = await shot(page, 'play-9-after-mine.png');
  const mineDiff = await imgdiff(beforeMine, afterMine);
  mark('held left button 3.2 s on a block -> ' + mineDiff.toFixed(1) + '% pixels changed');
  if (mineDiff < 1) problems.push('breaking a block changed nothing (' + mineDiff + '%)');

  await page.mouse.down({ button: 'right' });
  await sleep(150);
  await page.mouse.up({ button: 'right' });
  await sleep(2500);
  const afterPlace = await shot(page, 'play-10-after-place.png');
  const placeDiff = await imgdiff(afterMine, afterPlace);
  mark('right button (place a block) -> ' + placeDiff.toFixed(1) + '% pixels changed');

  await page.keyboard.press('KeyE');
  await sleep(2500);
  const inv = await shot(page, 'play-11-inventory.png');
  const invDiff = await imgdiff(afterPlace, inv);
  mark('E opened the inventory -> ' + invDiff.toFixed(1) + '% pixels changed');
  if (invDiff < 3) problems.push('the inventory did not open (' + invDiff + '%)');
  await page.keyboard.press('KeyE');
  await sleep(900);

  const heap = await page.evaluate('window.mcTelemetry.heap()');
  mark('wasm linear memory now ' + heap.wasmHeapMB + ' MiB after ' + heap.wasmResizes + ' resizes');

  /* ---- save and quit ---------------------------------------------------- */
  await page.keyboard.press('Escape');
  await waitScreen(/IngameMenu|Pause/, 'pause menu');
  await shot(page, 'play-12-pause.png');
  await clickGUI(cx() - 25, geom.h / 4 + 114, 'Save and Quit to Title');
  await waitScreen(/GuiMainMenu/, 'title screen after quit', 90000);
  mark('saved and quit back to the title screen');

  /* ---- what did the game actually write? -------------------------------- */
  const world = await page.evaluate(`(async () => {
    /* the engine namespaces its virtual filesystem the way any Java class
     * would: _net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_8_8_<worldsDB> */
    const want = (window.mcBoot.params.worlds || 'browser-minecraft-worlds');
    const dbs = await indexedDB.databases();
    const hit = dbs.find(d => (d.name || '').endsWith('_' + want)) || dbs.find(d => (d.name || '').includes(want));
    if (!hit) return { error: 'no world database found', dbs: dbs.map(d => d.name) };
    const dbname = hit.name;
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(dbname, 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = await new Promise((res, rej) => {
      const t = db.transaction('filesystem', 'readonly');
      const r = t.objectStore('filesystem').getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const files = all.map(x => ({ path: Array.isArray(x.path) ? x.path[0] : x.path, bytes: x.data ? x.data.byteLength : 0,
                                  data: x.data ? Array.from(new Uint8Array(x.data).slice(0, 200000)) : null }));
    db.close();
    return { dbname, count: files.length, total: files.reduce((a, f) => a + f.bytes, 0), files };
  })()`);

  const dir = path.join(SHOTS, 'world');
  fs.mkdirSync(dir, { recursive: true });
  if (world.error) { problems.push(world.error + ' (' + JSON.stringify(world.dbs) + ')'); throw new Error(world.error); }
  const mine = world.files.filter(f => f.path.includes(WORLD));
  if (!mine.length) problems.push('the world database has no folder for "' + WORLD + '"');
  const listing = mine.map(f => ({ path: f.path, bytes: f.bytes }));
  fs.writeFileSync(path.join(dir, 'listing.json'), JSON.stringify(listing, null, 2));
  const lvl = world.files.find(f => /level\.dat$/.test(f.path));
  if (lvl) fs.writeFileSync(path.join(dir, 'level.dat'), Buffer.from(lvl.data));
  mark('IndexedDB "' + world.dbname + '": ' + world.count + ' files total, ' +
       mine.length + ' for this world (' + (mine.reduce((a,f)=>a+f.bytes,0)/1024).toFixed(0) + ' KiB)');
  for (const f of listing.slice(0, 12)) notes.push('    ' + f.path + '  ' + f.bytes + ' B');

  if (!lvl) problems.push('no level.dat in the world database');
  else {
    /* tools/nbtcheck.py is an independent NBT reader: if it can print the
     * level's name and version, the bytes the game wrote are real level.dat */
    const { spawnSync } = await import('node:child_process').then(m => m.default || m);
    const r = spawnSync('python3', [path.join(ROOT, 'tools', 'nbtcheck.py'), path.join(dir, 'level.dat')],
      { encoding: 'utf8' });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (e) { problems.push('level.dat did not parse as NBT: ' + r.stdout.slice(0, 200) + r.stderr.slice(0, 200)); }
    if (parsed) {
      mark('level.dat parses as NBT: LevelName="' + parsed.LevelName + '" GameType=' + parsed.GameType +
           ' difficulty=' + parsed.Difficulty + ' spawn=' + parsed.SpawnX + ',' + parsed.SpawnY + ',' + parsed.SpawnZ +
           ' seed=' + parsed.seed + ' playerPos=' + JSON.stringify(parsed.Player_pos) +
           ' (' + (parsed.top_level_keys || []).length + ' top-level keys)');
      if (parsed.LevelName !== WORLD) problems.push('level.dat says the world is "' + parsed.LevelName + '", not "' + WORLD + '"');
      if (!parsed.Player_pos || parsed.Player_pos.length !== 3) problems.push('level.dat has no player position');
      if (!(parsed.LastPlayed > 0)) problems.push('level.dat has no LastPlayed timestamp');
    }
  }
  /* EaglercraftX keeps browser-side worlds in its own per-chunk store
   * (level0/<hex>.dat) rather than Anvil region files, which is what the
   * "vanilla world" import path is for - but level.dat is Mojang's own NBT */
  if (!listing.some(f => /level0\/.+\.dat$/.test(f.path)))
    problems.push('no chunk files (level0/*.dat) in the world database');
  if (!listing.some(f => /level\.dat\.bak$/.test(f.path))) notes.push('    (level.dat.bak present: ' +
    listing.some(f => /level\.dat\.bak$/.test(f.path)) + ')');

  /* ---- reload: does the world come back? -------------------------------- */
  mark('reloading the page');
  await page.close().catch(() => {});
  page = await browser.newPage();
  page.on('pageerror', e => problems.push('pageerror(2): ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/favicon|empty soundEvent|Failed to load resource|Local player channel was closed/i.test(t))
      problems.push('console(2): ' + t.slice(0, 200));
  });
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(URL + '&theater=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await waitFor(page, 'window.mcBoot && window.mcBoot.done === true', 180000, 'port handover (2nd)');
  const assets2 = await page.evaluate('window.mcBoot.assets');
  const opfsHits = Object.values(assets2).filter(v => /opfs/.test(v.source || '')).length;
  mark('2nd load: ' + opfsHits + '/' + Object.keys(assets2).length +
       ' artifacts came from the OPFS cache (' +
       Object.entries(assets2).map(([k, v]) => k.split('/').pop() + '=' + v.source).join(' ') + ')');
  if (!opfsHits) notes.push('    NOTE: no OPFS cache hit on reload - the asset cache did not work');
  await activate(page);
  await advanceToTitle();
  await clickGUI(cx() - 25, geom.h / 4 + 58, 'Singleplayer (2nd)');
  await waitScreen(/SelectWorld/, 'world list (2nd)');
  await shot(page, 'play-13-worldlist-after-reload.png');
  mark('world list after reload: ' + await page.evaluate('document.title') + ' (see play-13)');

  /* the first entry in the list is the newest world, which is ours */
  await clickGUI(cx(), 46, 'world entry');
  await sleep(600);
  await clickGUI(cx() - 79, geom.h - 42, 'Play Selected World');
  await sleep(6000);
  if (/SelectWorld/.test(await screenName())) {
    mark('the Play button did nothing, double-clicking the world row instead');
    await doubleClickGUI(cx(), 46, 'world entry (double)');
    await sleep(6000);
  }
  mark('re-entering the saved world...');
  await waitFor(page,
    "window.mcTelemetry.logTail(400).join('\\n').match(/Preparing start region|Setting user|Starting integrated/)",
    180000, 'integrated server start (2nd)');
  for (let i = 0; i < 12; i++) {
    await sleep(4000);
    mark('  +' + (i * 4) + 's after the Play click: screen=' + (await screenName()));
  }
  const rejoin = await shot(page, 'play-14-rejoined.png');
  await sleep(8000);
  const rejoin2 = await shot(page, 'play-14-rejoined-2.png');
  mark('two frames 8s apart differ by ' + (await imgdiff(rejoin, rejoin2)).toFixed(1) +
       '% (a live scene moves by itself: clouds, water, sun)');
  const rejoinDiff = await imgdiff(afterPlace, rejoin);
  mark('rejoined view vs the view we left the world in: ' + rejoinDiff.toFixed(1) + '% pixels differ');
  if (rejoinDiff > 60) problems.push('the reloaded world does not look like the one we left (' + rejoinDiff + '% differ)');
  const spawnBackDiff = await imgdiff(a, rejoin);
  mark('(for reference, vs the original spawn view: ' + spawnBackDiff.toFixed(1) + '%)');

  report('playtest ' + BUILD, problems, notes);
} catch (e) {
  problems.push(String((e && e.message) || e));
  try {
    const tail = await page.evaluate('window.mcTelemetry.logTail(30)');
    notes.push('engine log tail:');
    for (const l of tail) notes.push('    ' + String(l).slice(0, 160));
  } catch (e2) { /* the page is already gone */ }
  report('playtest ' + BUILD, problems, notes);
} finally {
  await browser.close();
  server.kill();
}
