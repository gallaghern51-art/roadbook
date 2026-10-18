// Two phone-layout fixes (owner, Oct 18 2026, "do both"):
//
//   · on a one-day trip the single day chip stretched across the whole strip;
//     chips are capped at 76px, so a short trip reads as a calendar
//   · the open panel's hide handle is the strip of map beside it: full height,
//     never over the panel's content, one glass chevron, and a tap anywhere on
//     the strip returns to the map. The map's hint chip (clipped to "Editi")
//     hides while the panel is open; the Mapbox wordmark and ⓘ stay visible.
//
//   npm run dev    # :5199 (RB_PORT overrides)
//   node tools/sims/panel-strip-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const PORT = process.env.RB_PORT ?? '5199';
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function open(page, days) {
  await page.goto(`http://localhost:${PORT}/`);
  { const guest = page.locator('.land-skip'); if (await guest.isVisible().catch(() => false)) await guest.click(); }
  await page.waitForSelector('.trip-card', { timeout: 20000 });
  if (days) {
    await page.evaluate((n) => {
      const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
      const rec = l.trips.find((r) => r.id === l.activeId) ?? l.trips[0];
      rec.trip.days = rec.trip.days.slice(1, 1 + n);
      rec.trip.meta.title = `Day ride (${n})`;
      localStorage.setItem('moto.trips.v1', JSON.stringify(l));
    }, days);
    await page.reload();
    { const guest = page.locator('.land-skip'); if (await guest.isVisible().catch(() => false)) await guest.click(); }
    await page.waitForSelector('.trip-card', { timeout: 20000 });
  }
  await page.click('.trip-card');
  await page.waitForSelector('.rchip', { timeout: 20000 });
}

for (const [width, height] of [[375, 812], [402, 874]]) {
  console.log(`\n── phone ${width}px ──`);
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (r) => (r.request().url().includes(`localhost:${PORT}`) ? r.continue() : r.abort()));

  // 1. a one-day trip: one chip, not a strip-wide button
  await open(page, 1);
  const chip = await page.locator('.rchip:not(.trip-seat)').first().boundingBox();
  check(chip && chip.width <= 76, `the lone day chip is ${Math.round(chip?.width)}px wide`);
  await page.locator('.rchip:not(.trip-seat)').first().click();
  await page.waitForSelector('.wp-row', { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOT(`panel-strip-1day-${width}`) });

  // 2. the strip is the handle
  const side = await page.locator('.main > .side').boundingBox();
  const tab = await page.locator('.panel-tab').boundingBox();
  check(tab && Math.abs(tab.x) <= 1 && Math.abs(tab.x + tab.width - side.x) <= 1, `the handle spans the map strip (${tab?.x.toFixed(1)} → ${(tab?.x + tab?.width).toFixed(1)}, panel at ${side.x.toFixed(1)})`);
  check(tab && tab.height >= side.height - 1, `the handle is the strip's full height (${Math.round(tab?.height)}px)`);
  const rows = await page.locator('.wp-row').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left));
  check(rows.every((x) => x >= tab.x + tab.width), 'no stop row starts under the handle');
  check(!(await page.locator('.map-hint').first().isVisible().catch(() => false)), 'the clipped map hint is hidden while the panel is open');
  const logo = await page.locator('.mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib').first().isVisible().catch(() => null);
  if (logo !== null) check(logo, 'the map attribution stays visible in the strip');
  // a tap low on the strip (not on the chevron) goes back to the map
  await page.touchscreen.tap(tab.x + tab.width / 2, tab.y + tab.height - 140);
  await page.waitForTimeout(400);
  check(await page.locator('.main').getAttribute('data-panel') === 'closed', 'a tap anywhere on the strip returns to the map');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`);
  await ctx.close();

  // 3. a long trip, in a fresh browser, still fills the row
  const ctx2 = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  const p2 = await ctx2.newPage();
  await p2.route('**/*', (r) => (r.request().url().includes(`localhost:${PORT}`) ? r.continue() : r.abort()));
  await open(p2, 0);
  const many = await p2.locator('.rchip:not(.trip-seat)').count();
  const widths = await p2.locator('.rchip:not(.trip-seat)').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  check(many >= 7 && widths.every((w) => w >= 44 && w <= 76), `an ${many}-day trip keeps its chips between 44 and 76px (${Math.round(Math.min(...widths))}–${Math.round(Math.max(...widths))})`);
  await p2.screenshot({ path: SHOT(`panel-strip-long-${width}`) });
  await ctx2.close();
}
await browser.close();
console.log(`\n${pass}/${pass + fail} panel-strip checks passed`);
process.exit(fail ? 1 : 0);
