/* harness.mjs - shared pieces for the browser tests.
 *
 * Everything here exists because a browser port has to be verified in a real
 * browser: the WASM has to actually instantiate, JSPI has to actually suspend,
 * WebGL has to actually draw, and IndexedDB has to actually survive a reload.
 * Headless Brave with SwiftShader is the CI GPU.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

export function startServer(port) {
  const srv = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => process.env.VERBOSE && process.stdout.write(d));
  srv.stderr.on('data', d => process.env.VERBOSE && process.stderr.write(d));
  return srv;
}

export async function launch() {
  return puppeteer.launch({
    executablePath: process.env.BROWSER || '/usr/bin/brave',
    headless: true,
    args: [
      '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--disable-brave-update', '--metrics-recording-only', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required'
    ]
  });
}

/* the engine refuses to open its audio context until a real user activation,
 * and shows its own "press any key" screen while it waits */
export async function activate(page) {
  const box = await page.$('#game').then(h => h && h.boundingBox());
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
}

export function watchPage(page, problems, { ignore = [] } = {}) {
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', r => problems.push('requestfailed: ' + r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('response', r => {
    if (r.status() >= 400 && !ignore.some(re => re.test(r.url())))
      problems.push('HTTP ' + r.status() + ' ' + r.url());
  });
  page.on('console', m => {
    const t = m.text();
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (ignore.some(re => re.test(t))) return;
    problems.push(m.type() + ': ' + t.slice(0, 300));
  });
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function waitFor(page, fn, timeout, label) {
  try {
    await page.waitForFunction(fn, { timeout, polling: 500 });
    return true;
  } catch (e) {
    throw new Error('timeout waiting for ' + (label || fn));
  }
}

export async function shot(page, name) {
  const p = path.join(SHOTS, name);
  await page.screenshot({ path: p });
  return p;
}

export function report(title, problems, notes) {
  console.log('\n== ' + title + ' ==');
  for (const n of notes || []) console.log('   ' + n);
  if (problems.length) {
    console.log('PROBLEMS (' + problems.length + '):');
    for (const p of problems.slice(0, 25)) console.log('   ! ' + p);
    console.log('FAIL');
    process.exitCode = 1;
  } else {
    console.log('PASS');
  }
}

/* keys the game itself uses; the harness sends them as real key events so the
 * engine's own pointer-lock and input paths are the thing under test */
export const KEYS = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sneak: 'ShiftLeft', inventory: 'KeyE', debug: 'F3'
};

export async function hold(page, code, ms) {
  await page.keyboard.down(code);
  await sleep(ms);
  await page.keyboard.up(code);
}

export async function tap(page, code, ms = 60) {
  await page.keyboard.press(code);
  await sleep(ms);
}

export function imgdiff(a, b) {
  return new Promise((resolve) => {
    const p = spawn('python3', [path.join(ROOT, 'tools', 'imgdiff.py'), a, b]);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => {
      const m = /([\d.]+)%/.exec(out);
      resolve(m ? parseFloat(m[1]) : -1);
    });
  });
}
