// The floating chrome's height reaches the map's furniture even when the trip
// screen mounts LATE — behind the signed-out landing gate, which is what a
// PWA cold launch straight into a trip looks like while the account session
// restores (field-caught, Sep 13 2026: the Satellite pill and the whole-trip
// hint sat in the masthead row). Cold-open with the screen persisted as
// 'trip', pass the gate, hide the panel, and measure.
//
//   npm run dev    # :5199  (a checkout with Supabase keys shows the gate)
//   node tools/sims/chrome-measure-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';

let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (routeMapbox(r)) return undefined;
  if (isMockTile(u)) return r.fulfill({ status: 204 });
  if (u.includes('localhost:5199')) return r.continue();
  return r.abort();
});
// a PWA that last closed on a trip, opening cold — the screen is persisted,
// the guest choice is not, so the gate (when configured) renders first
await page.addInitScript(() => { try { localStorage.setItem('moto.screen.v1', 'trip'); localStorage.removeItem('moto.guest.v1'); } catch {} });
await page.goto('http://localhost:5199/');
const guest = page.locator('.land-skip');
const gated = await guest.isVisible({ timeout: 4000 }).catch(() => false);
if (gated) await guest.click();
console.log(gated ? 'landing gate shown, passed' : 'no landing gate on this checkout (no Supabase keys) — the late-mount path is exercised by the panel toggle alone');
await page.waitForSelector('.modebar', { timeout: 15000 });
// map-full: the chrome floats and the furniture must clear it
if (await page.locator('.main').getAttribute('data-panel') === 'open') { await page.locator('.panel-tab').click(); }
await page.waitForFunction(() => document.querySelector('.app')?.classList.contains('map-full'), null, { timeout: 5000 });
await page.waitForTimeout(1200);
const m = await page.evaluate(() => {
  const g = (s) => document.querySelector(s);
  const r = (s) => { const e = g(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
  return { chromeH: g('.app')?.style.getPropertyValue('--chrome-h'), topchrome: r('.topchrome'), bs: r('.basemap-switch'), hint: r('.map-hint'), mastId: r('.mast-id') };
});
check(m.chromeH && parseInt(m.chromeH, 10) === m.topchrome.h && m.topchrome.h > 80, `--chrome-h is set to the floating chrome's real height (${m.chromeH} vs ${m.topchrome?.h}px)`);
check(m.bs && m.bs.top >= m.topchrome.bottom, `the Satellite pill sits below the chrome, not in the masthead row (pill top ${m.bs?.top}, chrome bottom ${m.topchrome?.bottom})`);
check(m.hint && m.hint.top >= m.topchrome.bottom, `the whole-trip hint sits below the chrome too (${m.hint?.top})`);
check(m.mastId && m.bs && !(m.bs.top < m.mastId.bottom && m.bs.bottom > m.mastId.top), 'nothing overlaps the trip-title card');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
