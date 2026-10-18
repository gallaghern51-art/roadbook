// The day panel's stop rows, rebuilt for a thumb (owner, Oct 18 2026: "the UI
// of these buttons on the trip editor are so small"; and "user to have to
// click a stop and click some button to move it so you don't accidentally
// drag it").
//
//   · every control on a stop row is ≥ 44pt; the name reads at ≥ 16px
//   · no row carries a drag grip until its actions sheet says Move
//   · tapping the stop opens its actions: Details, Swap, Move, Show on the
//     map, Show the leg in, Remove — each a full-width row ≥ 52pt
//   · Move lifts ONE row with ▲ / ▼ / Done; ▲ reorders the stored day;
//     Done puts it down and the grip goes away again
//   · the leg line is a real button and zooms the map to that leg
//   · Remove from the sheet removes one stop; Undo brings it back
//
//   npm run dev    # :5199 (RB_PORT overrides)
//   node tools/sims/stop-rows-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const PORT = process.env.RB_PORT ?? '5199';
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function run(width, label, mobile) {
  console.log(`\n── ${label} (${width}px) ──`);
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: mobile, isMobile: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (r) => (r.request().url().includes(`localhost:${PORT}`) ? r.continue() : r.abort()));
  await page.goto(`http://localhost:${PORT}/`);
  { const guest = page.locator('.land-skip'); if (await guest.isVisible().catch(() => false)) await guest.click(); }
  { const tb = page.locator('.hm-tripsbtn'); if (await tb.isVisible().catch(() => false)) { await tb.click(); await page.waitForTimeout(400); } }
  await page.waitForSelector('.trip-card', { timeout: 20000 });
  await page.click('.trip-card');
  await page.waitForSelector('.rchip', { timeout: 20000 });
  await page.locator('.rchip:not(.trip-seat)').nth(1).click();
  await page.waitForSelector('.wp-row', { timeout: 10000 });
  const day = () => page.evaluate(() => {
    const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
    const trip = l.trips.find((r) => r.id === l.activeId).trip;
    const id = document.querySelector('.day-head') && trip.days.find((d) => document.querySelector('.day-head h2')?.textContent.includes(d.title.slice(0, 12)))?.id;
    return (trip.days.find((d) => d.id === id) ?? trip.days[1]).waypoints.map((w) => w.id);
  });

  // 1. sizes
  const row = page.locator('.wp-row').nth(2);
  await row.scrollIntoViewIfNeeded();
  check(await page.locator('.wp-row .grip').count() === 0, 'no row carries a drag grip at rest');
  check(await page.locator('.wp-row .rm').count() === 0, 'the old 11px glyph buttons are gone');
  const more = await row.locator('.wp-more').boundingBox();
  check(more && more.width >= 44 && more.height >= 44, `⋯ is ${Math.round(more?.width)}×${Math.round(more?.height)}`);
  const main = await row.locator('.wp-main').boundingBox();
  check(main && main.height >= 44, `the stop itself is a ${Math.round(main?.height)}px-tall target`);
  const leg = await row.locator('.wp-leg').boundingBox();
  check(leg && leg.height >= 40, `the leg line is a ${Math.round(leg?.height)}px button`);
  const nmSize = await row.locator('.nm').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  check(nmSize >= 16, `the stop name reads at ${nmSize}px`);
  const over = await page.evaluate(() => [...document.querySelectorAll('.wp-row')].some((r) => r.scrollWidth > r.clientWidth + 1));
  check(!over, 'no stop row overflows sideways');
  await page.screenshot({ path: SHOT(`stop-rows-${width}`) });

  // 2. the actions sheet
  const name = (await row.locator('.nm').textContent()).trim();
  await row.locator('.wp-main').click();
  await page.waitForSelector('.stop-menu', { timeout: 5000 });
  const items = (await page.locator('.stop-menu .dm-row b').allTextContents()).map((s) => s.trim());
  for (const w of ['Details', 'Swap', 'Move', 'Show on the map', 'leg', 'Remove']) check(items.some((i) => i.includes(w)), `the sheet offers ${w}`);
  const hs = await page.locator('.stop-menu .dm-row').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  check(hs.every((h) => h >= 52), `every action is ≥ 52px (${hs.map(Math.round).join(', ')})`);
  check((await page.locator('.modal.sheet h3').textContent()).trim() === name, 'the sheet is titled with the stop');
  await page.screenshot({ path: SHOT(`stop-menu-${width}`) });

  // 3. Move: one row lifts, ▲ reorders, Done puts it down
  const before = await day();
  await page.locator('.stop-menu .dm-row:not(.danger)', { hasText: 'Move' }).click();
  await page.waitForSelector('.wp-row.moving', { timeout: 4000 });
  check(await page.locator('.wp-row.moving').count() === 1 && await page.locator('.wp-row .grip').count() === 1, 'Move lifts exactly one row, and only it has a grip');
  const btns = await page.locator('.wp-move button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  check(btns.every((h) => h >= 48), `▲ / ▼ / Done are ≥ 48px (${btns.map(Math.round).join(', ')})`);
  await page.screenshot({ path: SHOT(`stop-move-${width}`) });
  await page.locator('.wp-move .wm-step').first().click();
  await page.waitForTimeout(300);
  const after = await day();
  check(after.indexOf(before[2]) === 1 && after.indexOf(before[1]) === 2, '▲ moved the stop one place earlier in the stored day');
  check((await page.locator('.wp-row.moving .nm').textContent()).trim() === name, 'the lifted row follows the stop');
  await page.locator('.wp-move .wm-done').click();
  await page.waitForTimeout(200);
  check(await page.locator('.wp-row.moving').count() === 0 && await page.locator('.wp-row .grip').count() === 0, 'Done puts it down and the grip goes away');

  // 4. a touch drag on a resting row reorders nothing
  const mid = await page.locator('.wp-row').nth(3).boundingBox();
  if (mobile) {
    await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const mk = (type, yy) => new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: x, clientY: yy })], changedTouches: [new Touch({ identifier: 1, target: el, clientX: x, clientY: yy })] });
      el.dispatchEvent(mk('touchstart', y));
    }, { x: mid.x + 20, y: mid.y + 20 });
    await page.waitForTimeout(400);
  } else {
    await page.mouse.move(mid.x + 20, mid.y + 20); await page.mouse.down();
    await page.mouse.move(mid.x + 20, mid.y + 140, { steps: 8 }); await page.mouse.up();
  }
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape').catch(() => {});
  { const bd = page.locator('.modal-backdrop'); if (await bd.count()) await bd.first().click({ position: { x: 5, y: 5 } }).catch(() => {}); }
  check(JSON.stringify(await day()) === JSON.stringify(after), 'pressing and dragging a resting row reorders nothing');

  // 5. the leg line zooms the map
  await page.locator('.wp-row').nth(3).locator('.wp-leg').click();
  await page.waitForTimeout(300);
  if (mobile) check(await page.locator('.main[data-panel="closed"]').count() === 1, 'on a phone the leg tap steps the panel aside so the map shows the leg');

  // 6. remove from the sheet; Undo brings it back
  if (mobile) {
    await page.locator('.tabnav.modebar button').first().click(); // PLAN again brings the panel back
    await page.waitForTimeout(500);
  }
  const n0 = await page.locator('.wp-row').count();
  await page.locator('.wp-row').nth(2).locator('.wp-more').click();
  await page.locator('.stop-menu .dm-row.danger').click();
  await page.waitForTimeout(300);
  check(await page.locator('.wp-row').count() === n0 - 1, 'Remove in the sheet removes one stop');
  await page.getByRole('button', { name: 'Undo' }).first().click();
  await page.waitForTimeout(300);
  check(await page.locator('.wp-row').count() === n0, 'Undo brings it back');
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`);
  await ctx.close();
}

await run(375, 'phone', true);
await run(1280, 'desktop', false);
await browser.close();
console.log(`\n${pass}/${pass + fail} stop-row checks passed`);
process.exit(fail ? 1 : 0);
