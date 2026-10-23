/* livecheck.mjs - is the deployed port actually up, and is it the real thing?
 *
 *   node tools/livecheck.mjs https://browser-minecraft.onrender.com [wasm,js]
 *
 * Checks the parts that only exist once the port is on a real host:
 *   - /health answers, and reports the engine revision that was deployed
 *   - the COOP/COEP isolation headers survived the proxy
 *   - a big artifact really does answer a Range request with 206
 *   - the game boots in a browser from the live URL, cold and warm
 */
import { launch, sleep, waitFor, shot, report } from './harness.mjs';

const BASE = (process.argv[2] || 'https://browser-minecraft.onrender.com').replace(/\/$/, '');
const BUILDS = (process.argv[3] || 'wasm').split(',');

const problems = [];
const notes = [];

/* ---- headers and health, no browser needed ---- */
async function head(url) {
  const r = await fetch(url, { redirect: 'follow' });
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()) };
}

for (const [name, url] of [['/health', BASE + '/health'], ['/', BASE + '/']]) {
  try {
    const h = await head(url);
    notes.push(name + ' -> HTTP ' + h.status);
    if (h.status !== 200) problems.push(name + ' returned ' + h.status);
    if (name === '/') {
      for (const k of ['cross-origin-opener-policy', 'cross-origin-embedder-policy']) {
        if (!h.headers[k]) problems.push('missing ' + k + ' header on ' + url);
        else notes.push('  ' + k + ': ' + h.headers[k]);
      }
    }
    if (name === '/health') {
      const j = await (await fetch(url)).json();
      notes.push('  health ' + JSON.stringify(j));
      if (!j.ok) problems.push('health says not ok');
      if (!j.artifacts) problems.push('health reports zero artifacts');
      if (j.engine) notes.push('  engine ' + (j.engine.rev || '').slice(0, 12) + ' "' + j.engine.subject + '"');
    }
  } catch (e) {
    problems.push(name + ' unreachable: ' + e.message);
  }
}

/* ---- Range support: the asset streamer is useless without 206 ---- */
try {
  const man = await (await fetch(BASE + '/build/manifest.json')).json();
  const big = Object.entries(man.artifacts || {})
    .filter(([k]) => /classes\.wasm$|classes\.js$/.test(k))
    .sort((a, b) => b[1].size - a[1].size)[0];
  if (!big) problems.push('manifest lists no code artifact');
  else {
    const r = await fetch(BASE + '/build/' + big[0], { headers: { Range: 'bytes=0-1023' } });
    const len = Number(r.headers.get('content-length'));
    notes.push('Range ' + big[0] + ' (' + big[1].size + ' B) -> HTTP ' + r.status +
               ' content-length ' + len + ' content-range ' + r.headers.get('content-range'));
    if (r.status !== 206) problems.push('Range request returned ' + r.status + ', not 206');
    if (len !== 1024) problems.push('Range returned ' + len + ' bytes, expected 1024');
  }
} catch (e) {
  problems.push('manifest fetch failed: ' + e.message);
}

/* ---- boot it in a real browser, from the live URL ---- */
const browser = await launch();
for (const build of BUILDS) {
  const url = BASE + '/?build=' + build + '&theater=1';
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('requestfailed', r => errs.push('requestfailed: ' + r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  try {
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitFor(page, 'window.mcBoot && window.mcBoot.done === true', 120000, 'handover');
    await page.mouse.click(640, 400);
    await page.keyboard.press('Space');
    await waitFor(page, 'window.mcBoot.canvasSeen === true', 180000, 'engine canvas');
    await waitFor(page, "(window.mcTelemetry.screens().name||'') !== ''", 180000, 'game GUI');
    const cold = Date.now() - t0;
    const st = await page.evaluate(`({
      screen: window.mcTelemetry.screens().name,
      heap: window.mcTelemetry.heap(),
      assets: Object.fromEntries(Object.entries(window.mcBoot.assets).map(([k,v]) => [k, v.source])),
      isolated: self.crossOriginIsolated,
      jspi: typeof WebAssembly.Suspending === 'function'
    })`);
    notes.push(build + ' cold boot ' + (cold / 1000).toFixed(1) + 's -> ' + st.screen +
               ' (heap ' + st.heap.wasmHeapMB + ' MiB, isolated=' + st.isolated + ', jspi=' + st.jspi + ')');
    notes.push('  sources ' + JSON.stringify(st.assets));
    await shot(page, 'live-' + build + '.png');
    if (errs.length) problems.push(build + ' browser errors: ' + errs.slice(0, 4).join(' | '));
  } catch (e) {
    problems.push(build + ' live boot failed: ' + (e.message || e));
  } finally {
    await page.close();
  }
}
await browser.close();

report('livecheck ' + BASE, problems, notes);
