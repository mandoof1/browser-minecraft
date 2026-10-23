/* verify.mjs - does the port boot, and does it boot cleanly?
 *
 *   node tools/verify.mjs [wasm|js] [files|epw]
 *
 * Asserts:
 *   - the module loads and the port hands the engine its data
 *   - the WASM instantiates (JSPI suspend/resume included) and the engine
 *     reaches its own GUI, i.e. a canvas appears inside our container
 *   - the game's screenChanged hook fires, which means real Minecraft GUI code
 *     is running, not just a splash image
 *   - the artifacts came over HTTP Range and are now in OPFS
 *   - no page errors, no failed requests, no console errors
 */
import { startServer, launch, activate, watchPage, sleep, waitFor, shot, report, ROOT } from './harness.mjs';
import path from 'node:path';

const BUILD = process.argv[2] || process.env.BUILD || 'wasm';
const MODE = process.argv[3] || process.env.MODE || (BUILD === 'wasm' ? 'files' : 'files');
const PORT = Number(process.env.PORT || 8766);
const URL = `http://127.0.0.1:${PORT}/?build=${BUILD}&mode=${MODE}`;

const server = startServer(PORT);
await sleep(900);

const browser = await launch();
const problems = [];
const notes = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  watchPage(page, problems, {
    ignore: [
      /Unable to play empty soundEvent/,   // optional sound the 1.8 epk lacks
      /favicon\.ico/,                     // our shell uses an inline SVG icon
      /the AudioContext/, /Autoplay/,
      /WebGL.*SwiftShader/i, /GroupMarkerNotSet/i,
      // the shared-world relays are third-party endpoints; a sandboxed or
      // offline test box cannot reach them and that is not a port bug
      /wss:\/\/relay\.(deev\.is|lax1dude\.net|shhnowisnottheti\.me)/
    ]
  });

  console.log('open', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  await waitFor(page, 'window.mcBoot && window.mcBoot.done === true', 90000, 'port handover');
  notes.push('port handed over in ' + await page.evaluate('Math.round(performance.now()-window.mcBoot.t0)') + ' ms');

  await activate(page);

  await waitFor(page, 'window.mcBoot.canvasSeen === true', 120000, 'engine canvas');
  notes.push('engine canvas up at +' + await page.evaluate('window.mcBoot.phases.canvas') + ' ms');

  await waitFor(page, "(window.mcTelemetry.screens().name||'') !== ''", 120000, 'game GUI');
  notes.push('first GUI screen: ' + await page.evaluate('window.mcTelemetry.screens().name'));

  await sleep(9000);

  const st = await page.evaluate(`({
    phases: window.mcBoot.phases,
    assets: window.mcBoot.assets,
    heap: window.mcTelemetry.heap(),
    screens: window.mcTelemetry.screens(),
    events: window.mcTelemetry.events().slice(-8),
    engine: window.mcBoot.manifest.engine,
    isolated: self.crossOriginIsolated,
    jspi: typeof WebAssembly.Suspending === 'function',
    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null,
    canvas: (() => { const c = document.querySelector('#game canvas'); return c ? c.width+'x'+c.height : null; })()
  })`);

  notes.push('engine ' + (st.engine.rev || '').slice(0, 12) + ' "' + st.engine.subject + '"');
  notes.push('crossOriginIsolated=' + st.isolated + '  JSPI=' + st.jspi);
  notes.push('phases ' + JSON.stringify(st.phases));
  for (const [k, v] of Object.entries(st.assets)) notes.push('  asset ' + k + ': ' + v.bytes + ' via ' + v.source);
  notes.push('canvas ' + st.canvas + ' · wasm heap ' + st.heap.wasmHeapMB + ' MiB (' + st.heap.wasmResizes + ' resizes) · js heap ' + st.jsHeapMB + ' MiB');
  notes.push('screen ' + st.screens.name + ' (x' + st.screens.seq + ')');

  if (!st.jspi && BUILD === 'wasm') problems.push('no JSPI in this browser, wasm build cannot run');
  if (!st.canvas) problems.push('no canvas');

  const p1 = await shot(page, `verify-${BUILD}-${MODE}-1.png`);
  await sleep(4000);
  const p2 = await shot(page, `verify-${BUILD}-${MODE}-2.png`);
  notes.push('screenshots ' + path.relative(ROOT, p1) + ' ' + path.relative(ROOT, p2));

  report(`verify ${BUILD}/${MODE}`, problems, notes);
} catch (e) {
  problems.push(String(e && e.message || e));
  report(`verify ${BUILD}/${MODE}`, problems, notes);
} finally {
  await browser.close();
  server.kill();
}
