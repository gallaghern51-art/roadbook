// Installed-PWA shell: nothing may scroll the document.
//
// Three field reports from one iOS install, all the same fault:
//   "your change messed up the view on PWA"  — the "Editing …" chip and the
//       layers pill sitting above the masthead, under the status bar
//   "On PWA I can drag up as well"           — the whole app dragging upward,
//       masthead off the top, white below the mode bar
//   "trying to close the side bar detail … the view jumps into the upper
//    island buffer"                          — a layout change landing the
//       content under the Dynamic Island
//
// One cause. `--app-h` is a MEASURED height deliberately floored at
// screen.height (main.jsx explains why), so it is allowed to over-estimate the
// real viewport by a few pixels. An over-estimate makes the shell taller than
// the viewport, and iOS scrolls the document. Once the document scrolls, the
// masthead moves with it while the map's own furniture — positioned against the
// map, not the document — does not, so they slide past each other; a panel
// close changes the layout and the page keeps whatever scroll it had.
//
// `display-mode: standalone` is emulated through CDP, which is the only way to
// exercise that media block outside a real install. The over-estimate is forced
// rather than waited for, because on a desktop viewport it never happens by
// itself — the point is that when it DOES, nothing moves.
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160)));

// Chromium will not emulate `display-mode` through CDP here, so the standalone
// block is forced the honest way instead: the real stylesheet is served with
// that one media query widened to `all`. Every rule under test is the shipped
// rule, in the shipped cascade — only the gate that would normally require an
// actual home-screen install is removed.
await page.route('**/*', async (r) => {
  const url = r.request().url();
  if (!url.includes('5199')) return r.abort();
  if (!url.includes('app.css')) return r.continue();
  const res = await r.fetch();
  const body = (await res.text())
    .replace(/@media all and \(display-mode: standalone\)/g, '@media all')
    .replace(/@media all and \(display-mode:standalone\)/g, '@media all');
  return r.fulfill({ response: res, body });
});
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);
const guest = page.locator('.land-skip');
if (await guest.isVisible().catch(() => false)) await guest.click();
await page.waitForSelector('.trip-card', { timeout: 20000 });

const forced = await page.evaluate(() => getComputedStyle(document.documentElement).overflow);
check(forced === 'hidden', `the standalone block is in force (html overflow ${forced})`);

// The over-estimate the real device produces: --app-h a little taller than the
// viewport. Anything the shell does with that must not become a scroll.
const OVER = 40;
await page.evaluate((over) => {
  document.documentElement.style.setProperty('--app-h', `${window.innerHeight + over}px`);
}, OVER);
await page.waitForTimeout(300);

const scrollable = () => page.evaluate(() => ({
  docScroll: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight,
  rootScroll: (() => { const r = document.getElementById('root'); return r.scrollHeight - r.clientHeight; })(),
  htmlOverflow: getComputedStyle(document.documentElement).overflow,
  bodyOverflow: getComputedStyle(document.body).overflow,
  htmlBg: getComputedStyle(document.documentElement).backgroundColor,
}));

const home = await scrollable();
check(home.htmlOverflow === 'hidden' && home.bodyOverflow === 'hidden',
  `the document is pinned in standalone (html ${home.htmlOverflow}, body ${home.bodyOverflow})`);
check(home.htmlBg !== 'rgba(0, 0, 0, 0)' && home.htmlBg !== 'rgb(255, 255, 255)',
  `the canvas behind the shell is painted, never bare white (${home.htmlBg})`);

// Try to drag the page up, the way the rider did.
const drag = async () => {
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.mouse.move(200, 700);
  await page.mouse.down();
  await page.mouse.move(200, 300, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  return page.evaluate(() => Math.round(document.scrollingElement.scrollTop));
};
check(await drag() === 0, 'the home screen cannot be dragged up');

// ---- inside a trip, which is where all three reports came from -------------
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 20000 });
await page.waitForTimeout(2500);
await page.evaluate((over) => {
  document.documentElement.style.setProperty('--app-h', `${window.innerHeight + over}px`);
}, OVER);
await page.waitForTimeout(300);

const inTrip = await scrollable();
check(inTrip.docScroll <= 0, `the trip view has nothing to scroll (${inTrip.docScroll}px of overflow)`);
check(await drag() === 0, 'the trip view cannot be dragged up either');

// The chrome and the map furniture must stay in the same relationship — that
// is what "the chip ended up above the masthead" was.
const geom = () => page.evaluate(() => {
  const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  return { masthead: box('.masthead'), hint: box('.map-hint'), basemap: box('.basemap-switch'), scroll: Math.round(document.scrollingElement.scrollTop) };
});

// Open the panel, then close it — the report was about closing it.
await page.locator('.rchip').nth(1).click();
await page.waitForSelector('.wp-row', { timeout: 15000 });
await page.waitForTimeout(900);
const opened = await geom();
await page.locator('.panel-scrim').click({ force: true, timeout: 4000 }).catch(() => {});
await page.waitForTimeout(900);
const closed = await geom();

check(closed.scroll === 0, `closing the panel does not leave the view scrolled (${closed.scroll}px)`);
check(closed.masthead.top >= 0, `the masthead stays on screen after closing (top ${closed.masthead.top})`);
check(closed.hint === null || closed.hint.top >= closed.masthead.bottom - 1,
  `the map hint stays BELOW the chrome, not up under the status bar (hint ${closed.hint?.top} vs chrome ${closed.masthead.bottom})`);
check(closed.basemap === null || closed.basemap.top >= closed.masthead.bottom - 1,
  `the layers pill stays below the chrome too (${closed.basemap?.top})`);
console.log(`   panel open: masthead ${opened.masthead.top}, hint ${opened.hint?.top ?? '—'}`);
await page.screenshot({ path: SHOT('pwa-shell') });

// A measurement that is SHORT must not tear the layout either.
await page.evaluate(() => {
  document.documentElement.style.setProperty('--app-h', `${window.innerHeight - 60}px`);
});
await page.waitForTimeout(400);
const short = await geom();
check(short.scroll === 0 && short.masthead.top >= 0,
  'a short measurement leaves the shell pinned as well');

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
