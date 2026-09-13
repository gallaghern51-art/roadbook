// Phases are trip-owned words, not a rally assumption — and the day header
// is four chips wide, with everything else behind ⋯.
//
//   · the seed trip still says "Rally" (it names its phase in meta.phaseLabels)
//   · a blank trip says "Destination", never "Rally"
//   · renaming a phase in Trip settings → Advanced re-labels the day chip,
//     the day-options segment and the stop detail eyebrow — one set_meta op
//   · the day header holds Depart · End · phase · ⋯ and nothing else; GPX,
//     Copilot, anchor and phase all live in the ⋯ sheet
//
//   npm run dev    # :5199
//   node tools/sims/phases-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function run(width, label) {
  console.log(`\n── ${label} (${width}px) ──`);
  const ctx = await browser.newContext({ viewport: { width, height: 820 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/*', (r) => (r.request().url().includes('localhost:5199') ? r.continue() : r.abort()));
  await page.goto('http://localhost:5199/');
  await page.waitForSelector('.trip-card', { timeout: 20000 });
  const lib = () => page.evaluate(() => JSON.parse(localStorage.getItem('moto.trips.v1')));
  const meta = async () => { const l = await lib(); return l.trips.find((r) => r.id === l.activeId).trip.meta; };

  // 1. the seed trip: a rally day says Rally because THIS trip says so
  await page.click('.trip-card');
  await page.waitForSelector('.rchip', { timeout: 20000 });
  const seedMeta = await meta();
  check(seedMeta.phaseLabels?.rally === 'Rally', 'the Sturgis seed names its destination phase "Rally" on the trip itself');
  const chips = page.locator('.rchip:not(.trip-seat)');
  await chips.nth(4).click(); // a Black Hills day
  await page.waitForSelector('.day-head .phase-chip', { timeout: 10000 });
  const chipText = (await page.locator('.day-head .phase-chip').textContent()).trim();
  check(/^Rally/.test(chipText), `the day chip reads the trip's own word ("${chipText}")`);
  const headKids = await page.locator('.day-head .chip').count();
  check(headKids <= 4, `the day header is ${headKids} chips wide — Depart · End · phase · ⋯`);
  for (const sel of ['.day-head .gpx-btn', '.day-head .ask-ai', '.day-head .anchor-toggle', '.day-head select']) {
    check(await page.locator(sel).count() === 0, `${sel} is not in the header`);
  }
  const head = await page.locator('.day-head').boundingBox();
  check(head && head.width <= width, `the header fits the viewport (${Math.round(head?.width)} ≤ ${width})`);
  await page.screenshot({ path: SHOT(`phases-day-head-${width}`) });

  // 2. ⋯ carries phase, anchor, Copilot, opportunities, GPX
  await page.locator('.day-head .day-more').click();
  await page.waitForSelector('.day-menu', { timeout: 6000 });
  for (const [sel, name] of [['.dm-seg', 'phase'], ['.anchor-toggle', 'anchor'], ['.ask-ai', 'Copilot'], ['.gpx-btn', 'GPX']]) {
    check(await page.locator(`.day-menu ${sel}`).count() >= 1, `⋯ holds ${name}`);
  }
  const segWords = await page.locator('.day-menu .phase-select').allTextContents();
  check(segWords.some((w) => /Rally/.test(w)) && !segWords.some((w) => /Destination/.test(w)), `the phase segment speaks the trip's words (${segWords.map((w) => w.trim()).join(' · ')})`);
  await page.screenshot({ path: SHOT(`phases-day-menu-${width}`) });
  await page.locator('.day-menu .phase-select', { hasText: 'Return' }).click();
  await page.waitForTimeout(300);
  check(/^Return/.test((await page.locator('.day-head .phase-chip').textContent()).trim()), 'picking a phase in ⋯ re-labels the chip');
  await page.locator('.day-menu .phase-select', { hasText: 'Rally' }).click();
  await page.waitForTimeout(200);
  await page.locator('.modal.sheet .modal-head .btn').last().click();
  await page.waitForTimeout(300);

  // 3. rename the phase for THIS trip: chip + segment + stop detail follow
  await page.locator('.rchip.trip-seat').first().click();
  await page.waitForSelector('.trip-settings-btn', { timeout: 10000 });
  check(await page.locator('.ov-day-actions .btn, .trip-settings-btn').count() <= 4, 'the trip overview leads with a handful of actions, settings behind one button');
  await page.screenshot({ path: SHOT(`phases-overview-${width}`) });
  await page.locator('.trip-settings-btn').click();
  await page.waitForSelector('.settings-adv', { timeout: 6000 });
  check(await page.locator('.modal.sheet input[type="number"]:not(.settings-adv input)').count() <= 3, 'pace / MPG / offset are folded under Advanced, not on the face of the sheet');
  await page.locator('.settings-adv summary').click();
  const rallyInput = page.locator('.settings-adv label', { hasText: 'Destination' }).locator('input');
  check((await rallyInput.inputValue()) === 'Rally', 'the Advanced block shows this trip\'s word for the destination phase');
  await rallyInput.fill('Black Hills');
  await rallyInput.press('Tab');
  await page.waitForTimeout(400);
  const after = await meta();
  check(after.phaseLabels?.rally === 'Black Hills', `the rename is a set_meta write (${JSON.stringify(after.phaseLabels)})`);
  await page.locator('.modal.sheet .modal-head .btn').last().click();
  await page.waitForTimeout(200);
  await chips.nth(4).click();
  await page.waitForSelector('.day-head .phase-chip', { timeout: 10000 });
  check(/^Black Hills/.test((await page.locator('.day-head .phase-chip').textContent()).trim()), 'the day chip follows the rename');
  await page.locator('.wp-row .rm.info').nth(1).click();
  await page.waitForSelector('.modal .eyebrow', { timeout: 6000 }).catch(() => {});
  const eyebrow = await page.locator('.modal .eyebrow').first().textContent().catch(() => '');
  check(/Black Hills/.test(eyebrow), `the stop detail eyebrow follows it too ("${eyebrow.trim()}")`);
  await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.locator('.masthead .btn', { hasText: 'Undo' }).first().click();
  await page.waitForTimeout(400);
  check((await meta()).phaseLabels?.rally === 'Rally', 'and it undoes in one step');

  // 4. a blank trip inherits nothing: Destination, never Rally
  await page.locator('.mast-back').click();
  await page.waitForSelector('.home', { timeout: 10000 });
  await page.locator('.start-card', { hasText: 'Blank' }).click();
  await page.waitForSelector('.modal', { timeout: 6000 });
  await page.locator('.modal button', { hasText: 'Blank' }).click().catch(() => {});
  await page.fill('.modal .fld input[placeholder*="Blue Ridge"]', 'Blue Ridge week');
  await page.locator('.btn.gold', { hasText: 'Create trip' }).click();
  await page.waitForSelector('.rchip', { timeout: 15000 });
  await page.waitForTimeout(500);
  const blankMeta = await meta();
  check(!blankMeta.phaseLabels, 'a blank trip carries no phase names of its own');
  await page.locator('.rchip:not(.trip-seat)').first().click();
  await page.waitForSelector('.day-head .day-more', { timeout: 10000 });
  await page.locator('.day-head .day-more').click();
  await page.waitForSelector('.day-menu', { timeout: 6000 });
  const words = (await page.locator('.day-menu .phase-select').allTextContents()).map((w) => w.trim());
  check(words.some((w) => /Destination/.test(w)) && !words.some((w) => /Rally/.test(w)), `its phases are agnostic (${words.join(' · ')})`);
  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
