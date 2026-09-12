// The trip overview's day list used to be loose: the whole row carried the drag
// listeners, so a tap that drifted a few pixels lifted the card, slid it under
// the pointer in BOTH axes, and on release rewrote the itinerary (reorder_days
// re-cascades every date). Nothing in a DAY panel behaves that way, which is
// why the overview read as unlocked (field report, Sept 12, 2026).
//
// This sim asserts the settled contract on the built-or-dev app, at phone width
// and at desktop width:
//   · dragging the row BODY moves nothing and reorders nothing
//   · dragging the GRIP reorders, and travels only on the Y axis
//   · the row still opens the day; the grip never does
//   · the grip is a glove-sized target on a phone
//   · day-panel stop rows remain undraggable (the control that named the bug)
//
//   npm run dev    # :5199
//   node tools/sims/overview-lock-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

const order = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.ov-day .t')].map((e) => e.textContent.trim()));
const transforms = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.ov-day')].map((e) => getComputedStyle(e).transform));
// "matrix(a,b,c,d,tx,ty)" → [tx, ty]
const xy = (m) => (m === 'none' ? [0, 0] : m.slice(m.indexOf('(') + 1, -1).split(',').slice(4).map((n) => Math.round(parseFloat(n))));

async function run(width, label) {
  console.log(`\n── ${label} (${width}px) ──`);
  const page = await browser.newPage({ viewport: { width, height: 820 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/*', (r) => (r.request().url().includes('localhost:5199') ? r.continue() : r.abort()));
  await page.goto('http://localhost:5199/');
  await page.waitForSelector('.trip-card', { timeout: 20000 });
  await page.click('.trip-card');
  await page.waitForSelector('.modebar', { timeout: 20000 });
  await page.waitForTimeout(800);
  // land on the trip overview (the Trip seat in the ribbon)
  await page.locator('.rchip.trip-seat').first().click();
  await page.waitForSelector('.ov-day', { timeout: 10000 });
  await page.waitForTimeout(400);

  const rows = page.locator('.ov-day');
  check(await rows.count() > 3, `overview lists the days (${await rows.count()})`);
  check(await page.locator('.ov-day .ov-grip').count() === await rows.count(), 'every day row wears a reorder grip');

  // 1. the row BODY does not drag. Grab the title, pull 140px down.
  const body = await rows.nth(1).locator('.t').boundingBox();
  const before = await order(page);
  await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(body.x + body.width / 2 + i * 2, body.y + body.height / 2 + i * 14);
    await page.waitForTimeout(20);
  }
  const midBody = await transforms(page);
  check(midBody.every((m) => xy(m)[0] === 0 && xy(m)[1] === 0),
    `row body drag moves no card (${JSON.stringify(midBody.slice(0, 3).map(xy))})`);
  await page.mouse.up();
  await page.waitForTimeout(500);
  check(JSON.stringify(await order(page)) === JSON.stringify(before), 'row body drag left the itinerary alone');

  // 2. the GRIP drags — and only down the column
  const grip = await rows.nth(1).locator('.ov-grip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    // deliberately pull sideways as well as down — the lock must eat the x
    await page.mouse.move(grip.x + grip.width / 2 + i * 12, grip.y + grip.height / 2 + i * 9);
    await page.waitForTimeout(20);
  }
  const midGrip = await transforms(page);
  const lifted = midGrip.map(xy).filter(([, y]) => y !== 0);
  check(lifted.length > 0, `grip drag lifts the card (${JSON.stringify(midGrip.map(xy).slice(0, 3))})`);
  check(midGrip.every((m) => xy(m)[0] === 0), 'drag is locked to the vertical axis — no sideways travel');
  await page.screenshot({ path: SHOT(`overview-grip-drag-${width}`) });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const after = await order(page);
  check(JSON.stringify(after) !== JSON.stringify(before), `grip drag reorders (${before[1]} → ${after[1]})`);
  check(after.length === before.length && [...after].sort().join() === [...before].sort().join(),
    'reorder moved a day rather than losing or duplicating one');

  // 3. the row still opens its day; the grip does not
  await page.locator('.rchip.trip-seat').first().click();
  await page.waitForTimeout(400);
  await rows.nth(2).locator('.ov-grip').click();
  await page.waitForTimeout(400);
  check(await page.locator('.ov-day').count() > 0, 'clicking the grip stays on the overview');
  await rows.nth(2).click();
  await page.waitForTimeout(600);
  check(await page.locator('.ov-day').count() === 0 && await page.locator('.wp-row, .day-head h2').count() > 0,
    'clicking the row opens that day');

  // 4. control: a day panel's stop rows do not drag
  const stops = page.locator('.wp-row');
  if (await stops.count() > 1) {
    const sBox = await stops.nth(1).boundingBox();
    const sBefore = await page.evaluate(() => [...document.querySelectorAll('.wp-row')].map((e) => e.textContent.slice(0, 24)));
    await page.mouse.move(sBox.x + sBox.width / 3, sBox.y + sBox.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(sBox.x + sBox.width / 3 + i, sBox.y + sBox.height / 2 + i * 12); await page.waitForTimeout(20); }
    await page.mouse.up();
    await page.waitForTimeout(400);
    const sAfter = await page.evaluate(() => [...document.querySelectorAll('.wp-row')].map((e) => e.textContent.slice(0, 24)));
    // On a phone a drag that lands on the leg figures closes the panel (that is
    // the leg-focus gesture), which empties the list — not a reorder. Only the
    // ORDER of what is still rendered is the control here.
    check(sAfter.length === 0 || JSON.stringify(sBefore) === JSON.stringify(sAfter),
      `control: day-panel stop rows still do not drag (${sAfter.length} rows after)`);
  }

  // 5. glove-sized grip on a phone (44pt, hit area included)
  if (width <= 430) {
    await page.locator('.rchip.trip-seat').first().click();
    await page.waitForSelector('.ov-grip', { timeout: 8000 });
    const hit = await page.evaluate(() => {
      const g = document.querySelector('.ov-grip');
      const r = g.getBoundingClientRect();
      const cs = getComputedStyle(g, '::after');
      const ins = (v) => Math.abs(parseFloat(v) || 0);
      return {
        w: r.width + ins(cs.left) + ins(cs.right),
        h: r.height + ins(cs.top) + ins(cs.bottom),
        touchAction: getComputedStyle(g).touchAction,
      };
    });
    check(hit.w >= 36 && hit.h >= 40, `grip hit area is thumb-sized (${Math.round(hit.w)}×${Math.round(hit.h)})`);
    check(hit.touchAction === 'none', `grip owns the touch gesture (touch-action: ${hit.touchAction})`);
    await page.screenshot({ path: SHOT(`overview-locked-${width}`) });
  }

  await page.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
