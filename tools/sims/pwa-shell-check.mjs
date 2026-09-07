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
// The first repair removed the measured-height shell and put the right rules
// behind `(display-mode: standalone)`. The physical install still showed all
// three failures because its Apple standalone state did not enter that media
// block. It therefore kept the ordinary 100dvh shell, no document pin, and no
// legacy safe-area fallback. The late visual-system `.masthead` rule also
// overwrote the normal Safari inset whenever the panel was open.
//
// The original regression test widened the display-mode media query in Chrome.
// That proved its CSS worked when the query matched, but the field failure was
// the opposite: legacy iOS Home Screen installs can identify themselves only
// through navigator.standalone. Emulate that Apple API and leave the shipped
// stylesheet completely untouched.
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const baseUrl = process.env.SIM_BASE_URL ?? 'http://127.0.0.1:5199/';
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
});
await ctx.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => true });
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160)));
await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);
const guest = page.locator('.land-skip');
if (await guest.isVisible().catch(() => false)) await guest.click();
await page.waitForSelector('.trip-card', { timeout: 20000 });

const shellMode = await page.evaluate(() => ({
  mode: document.documentElement.dataset.appDisplay,
  apple: document.documentElement.hasAttribute('data-apple-standalone'),
  overflow: getComputedStyle(document.documentElement).overflow,
}));
check(shellMode.mode === 'standalone' && shellMode.apple,
  `navigator.standalone activates the installed shell (${shellMode.mode}, Apple ${shellMode.apple})`);
check(shellMode.overflow === 'hidden', `the standalone shell is pinned (html overflow ${shellMode.overflow})`);

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

// ---- idle map stability / flashing regression ----------------------------
// The flashing report was a redraw feedback loop: drawAll wrote GeoJSON,
// sourcedata/styledata called drawAll again, and every pass destroyed and
// recreated the waypoint markers. Observe the user-visible consequence and
// the app-owned sources after the route and camera have settled.
const stableMap = await page.evaluate(async () => {
  const map = window.__map;
  const container = map?.getContainer() ?? document.querySelector('.map-wrap');
  if (!container) return null;
  await new Promise((resolve) => setTimeout(resolve, 900));
  const before = [...document.querySelectorAll('.wp-marker')];
  let appSourceEvents = 0;
  let styleEvents = 0;
  let markerChurn = 0;
  const onSource = (e) => {
    if (/^(route-|leg-hi|route-drag)/.test(e.sourceId ?? '')) appSourceEvents++;
  };
  const onStyle = () => { styleEvents++; };
  map?.on('sourcedata', onSource);
  map?.on('styledata', onStyle);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.('.wp-marker') || node.querySelector?.('.wp-marker')) markerChurn++;
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  observer.disconnect();
  map?.off('sourcedata', onSource);
  map?.off('styledata', onStyle);
  const after = [...document.querySelectorAll('.wp-marker')];
  return {
    appSourceEvents: map ? appSourceEvents : null,
    styleEvents: map ? styleEvents : null,
    markerChurn,
    before: before.length, after: after.length,
    sameMarkers: before.length === after.length && before.every((node, i) => node === after[i] && node.isConnected),
  };
});
check(stableMap && stableMap.sameMarkers,
  `idle waypoint markers keep their identity (${stableMap?.before} → ${stableMap?.after})`);
check(stableMap && stableMap.markerChurn === 0,
  `idle map has no marker rebuilds (${stableMap?.markerChurn})`);
check(stableMap && (stableMap.appSourceEvents == null
  ? stableMap.markerChurn === 0 && stableMap.sameMarkers
  : stableMap.appSourceEvents === 0 && stableMap.styleEvents === 0),
  `idle map has no redraw feedback (${stableMap?.appSourceEvents ?? 'production DOM probe'} app-source, ${stableMap?.styleEvents ?? 0} style events)`);

// ---- the shell fills the viewport exactly: no scroll AND no dead space -----
// Old builds wrote --app-h. A cached inline value must be harmless now.
for (const delta of [+80, -80]) {
  await page.evaluate((d) => {
    document.documentElement.style.setProperty('--app-h', `${window.innerHeight + d}px`);
  }, delta);
  await page.waitForTimeout(350);
  const fit = await page.evaluate(() => {
    const a = document.querySelector('.app').getBoundingClientRect();
    return {
      top: Math.round(a.top), bottom: Math.round(a.bottom),
      viewport: window.innerHeight,
      scroll: Math.round(document.scrollingElement.scrollTop),
    };
  });
  check(fit.top === 0 && Math.abs(fit.bottom - fit.viewport) <= 1 && fit.scroll === 0,
    `--app-h ${delta > 0 ? 'over' : 'under'}-reporting by ${Math.abs(delta)}px leaves no gap and no scroll `
    + `(shell ${fit.top}→${fit.bottom} of ${fit.viewport})`);
}

// ---- the top chrome clears the status bar even with no reported inset ------
// env(safe-area-inset-top) is 0 in a desktop browser, which is exactly the
// case a stale home-screen install produces on a real phone.
// Measured in BOTH states: with the panel open the masthead is the top bar and
// carries the inset; in map-full the floating .topchrome carries it instead,
// and each is set by a different rule.
const chromeIn = async () => page.evaluate(() => {
  const el = (s) => document.querySelector(s);
  const r = (s) => { const e = el(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) }; };
  const m = el('.masthead');
  const tc = el('.topchrome');
  const mapFull = document.querySelector('.app').classList.contains('map-full');
  return {
    mapFull,
    // What the top of the chrome actually reserves, whichever element owns it.
    reserved: Math.round(parseFloat(getComputedStyle(mapFull ? tc : m).paddingTop))
      + (mapFull ? Math.round(parseFloat(getComputedStyle(m).paddingTop)) : 0),
    back: r('.mast-back'),
    gear: r('.masthead .actions .btn.icon'),
  };
});
const chrome = await chromeIn();
check(chrome.reserved >= 59,
  `map-full reserves the status bar even with env() at 0 (${chrome.reserved}px)`);
check(!chrome.back || chrome.back.top >= 59,
  `map-full: the back button sits below the status bar (top ${chrome.back?.top})`);

// Re-open the panel (the day is already selected, so the tab is the way back).
await page.locator('.panel-tab').click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(900);
const withPanel = await chromeIn();
check(withPanel.reserved >= 59,
  `panel open reserves it too (${withPanel.reserved}px)`);
check(!withPanel.back || withPanel.back.top >= 59,
  `panel open: the back button sits below the status bar (top ${withPanel.back?.top})`);
check(!chrome.back || (chrome.back.h >= 44 && chrome.back.w >= 44),
  `the back button is a 44pt target (${chrome.back?.w}x${chrome.back?.h})`);
check(!chrome.gear || (chrome.gear.h >= 44 && chrome.gear.w >= 44),
  `the settings button is a 44pt target (${chrome.gear?.w}x${chrome.gear?.h})`);

const bottom = await page.evaluate(() => {
  const bar = document.querySelector('.modebar');
  const box = bar.getBoundingClientRect();
  return {
    bottom: Math.round(box.bottom),
    viewport: window.innerHeight,
    padding: Math.round(parseFloat(getComputedStyle(bar).paddingBottom)),
  };
});
check(bottom.bottom === bottom.viewport && bottom.padding === 12,
  `the mode bar reaches the edge with compact gesture clearance (bottom ${bottom.bottom}, inset ${bottom.padding}px)`);

// A measurement that is SHORT must not tear the layout either.
await page.evaluate(() => {
  document.documentElement.style.setProperty('--app-h', `${window.innerHeight - 60}px`);
});
await page.waitForTimeout(400);
const short = await geom();
check(short.scroll === 0 && short.masthead.top >= 0,
  'a short measurement leaves the shell pinned as well');

// ---- ordinary Safari ------------------------------------------------------
// Browser mode does not get the standalone guard. Its real env() value still
// has to survive the late premium masthead rules in both panel states. Chromium
// has no phone safe-area env, so override the custom property with the 59pt
// inset from the field device and exercise the shipped cascade.
const safariCtx = await browser.newContext({
  viewport: { width: 393, height: 730 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
});
const safari = await safariCtx.newPage();
await safari.goto(baseUrl, { waitUntil: 'domcontentloaded' });
await safari.waitForTimeout(400);
const safariGuest = safari.locator('.land-skip');
if (await safariGuest.isVisible().catch(() => false)) await safariGuest.click();
await safari.waitForSelector('.trip-card', { timeout: 20000 });
await safari.click('.trip-card');
await safari.waitForSelector('.modebar', { timeout: 20000 });
await safari.evaluate(() => {
  document.documentElement.style.setProperty('--viewport-safe-top', '59px');
  document.documentElement.style.setProperty('--viewport-safe-bottom', '34px');
});
await safari.waitForTimeout(350);
const browserPanel = await safari.evaluate(() => {
  const back = document.querySelector('.mast-back').getBoundingClientRect();
  const app = document.querySelector('.app').getBoundingClientRect();
  return {
    mode: document.documentElement.dataset.appDisplay,
    backTop: Math.round(back.top), appBottom: Math.round(app.bottom),
    viewport: window.innerHeight,
  };
});
check(browserPanel.mode === 'browser', `ordinary Safari keeps browser shell semantics (${browserPanel.mode})`);
check(browserPanel.backTop >= 67,
  `Safari panel chrome respects its safe-area inset (back top ${browserPanel.backTop})`);
check(Math.abs(browserPanel.appBottom - browserPanel.viewport) <= 1,
  `Safari shell ends at its dynamic viewport (${browserPanel.appBottom}/${browserPanel.viewport})`);
await safari.locator('.panel-scrim').click({ force: true });
await safari.waitForTimeout(500);
const browserMap = await safari.evaluate(() => {
  const back = document.querySelector('.mast-back').getBoundingClientRect();
  const hint = document.querySelector('.map-hint')?.getBoundingClientRect();
  const chrome = document.querySelector('.topchrome').getBoundingClientRect();
  return { backTop: Math.round(back.top), hintTop: hint && Math.round(hint.top), chromeBottom: Math.round(chrome.bottom) };
});
check(browserMap.backTop >= 67,
  `Safari map chrome respects the same safe-area inset (back top ${browserMap.backTop})`);
check(browserMap.hintTop == null || browserMap.hintTop >= browserMap.chromeBottom,
  `Safari map furniture remains below the floating chrome (${browserMap.hintTop}/${browserMap.chromeBottom})`);
await safari.screenshot({ path: SHOT('safari-shell') });
await safariCtx.close();

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
