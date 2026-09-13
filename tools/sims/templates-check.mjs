// Templates: save a trip as a starting point, copy it into a new trip, lay some
// of its days into an EXISTING trip, share it as a file, and import one back.
//
// The contract this asserts, in order:
//   · a template is a library record wearing trip.meta.template, so it backs up
//     and exports for free — and it never appears in the trip list
//   · saving one does not switch you out of the trip you are in
//   · a copy gets fresh ids, a new start date, and NO booking claims
//   · inserting days is one undoable op, and the calendar re-pins
//   · Share downloads a .json whose flag survives the round trip
//   · importing that file lands a template, not a trip
//
//   npm run dev    # :5199
//   node tools/sims/templates-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function run(width, label) {
  console.log(`\n── ${label} (${width}px) ──`);
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/*', (r) => (r.request().url().includes('localhost:5199') ? r.continue() : r.abort()));
  await page.goto('http://localhost:5199/');
  await page.waitForSelector('.trip-card', { timeout: 20000 });

  const lib = () => page.evaluate(() => JSON.parse(localStorage.getItem('moto.trips.v1')));

  // 0. mark a bed as booked so we can prove a copy does not inherit the claim
  await page.click('.trip-card');
  await page.waitForSelector('.modebar', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
    const rec = l.trips.find((r) => r.id === l.activeId);
    const d = rec.trip.days[1];
    window.__dispatch({ type: 'apply_ops', ops: [{ op: 'update_lodging', dayId: d.id, patch: { status: 'booked', name: 'Test Motel' } }] });
  });
  await page.waitForTimeout(400);

  // 1. save the current trip as a template, from the trip overview
  await page.locator('.rchip.trip-seat').first().click();
  await page.waitForSelector('.tpl-save .btn', { timeout: 10000 });
  const tripsBefore = (await lib()).trips.length;
  const screenBefore = await page.locator('.modebar').count();
  await page.locator('.tpl-save .btn').click();
  await page.waitForSelector('.sheet input, .modal input', { timeout: 6000 });
  await page.fill('.sheet input, .modal input', 'Early exit from Red Lodge');
  await page.locator('.btn.gold', { hasText: 'Save template' }).click();
  await page.waitForTimeout(600);
  const afterSave = await lib();
  const tpl = afterSave.trips.find((r) => r.trip?.meta?.template);
  check(!!tpl && tpl.name === 'Early exit from Red Lodge', `saving writes a template record ("${tpl?.name}")`);
  check(afterSave.trips.length === tripsBefore + 1 && afterSave.activeId !== tpl.id,
    'saving a template does not switch you out of the trip');
  check(await page.locator('.modebar').count() === screenBefore, 'you stay in the trip you were in');
  const bookedInTpl = tpl.trip.days.some((d) => d.lodging?.status === 'booked');
  check(!bookedInTpl, 'the template carries no confirmed bookings');

  // 2. it shows on Home under templates, and NOT in the trip list
  await page.locator('.mast-back').click();
  await page.waitForSelector('.home', { timeout: 10000 });
  await page.waitForTimeout(500);
  check(await page.locator('.tpl-card').count() === 1, 'the template has its own card on Home');
  const tripCardNames = await page.locator('.trip-grid:not(.start-grid) .trip-card:not(.tpl-card) .tc-name').allTextContents();
  check(!tripCardNames.includes('Early exit from Red Lodge'), 'a template is not listed as a trip');
  await page.screenshot({ path: SHOT(`templates-home-${width}`) });

  // 3. copy it into a new trip — fresh ids, new dates, still unbooked
  await page.locator('.tpl-card .tc-open').click();
  await page.waitForSelector('.template-create', { timeout: 8000 });
  check(await page.locator('.tpl-pick button').count() >= 2, 'the picker offers Sturgis plus your own templates');
  const active = await page.locator('.tpl-pick button.active b').textContent();
  check(active === 'Early exit from Red Lodge', `the card you pressed is preselected ("${active}")`);
  await page.fill('.template-create input[type="date"]', '2027-05-04');
  await page.fill('.template-create .fld input:not([type="date"])', 'Red Lodge run');
  await page.locator('.btn.gold', { hasText: 'Create from template' }).click();
  await page.waitForSelector('.modebar', { timeout: 15000 });
  await page.waitForTimeout(900);
  const afterCopy = await lib();
  const made = afterCopy.trips.find((r) => r.id === afterCopy.activeId);
  check(made.name === 'Red Lodge run' && !made.trip.meta.template, 'the copy is an ordinary trip');
  check(made.trip.days[0].date === '2027-05-04', `dates re-pin to the new start (${made.trip.days[0].date})`);
  const sameIds = made.trip.days.some((d) => tpl.trip.days.some((x) => x.id === d.id));
  check(!sameIds, 'the copy carries fresh day ids — editing one cannot touch the other');
  const wpIds = new Set(made.trip.days.flatMap((d) => d.waypoints.map((w) => w.id)));
  const tplWpIds = new Set(tpl.trip.days.flatMap((d) => d.waypoints.map((w) => w.id)));
  check(![...wpIds].some((id) => tplWpIds.has(id)), 'and fresh stop ids');
  const gates = made.trip.days.flatMap((d) => d.gates ?? []).filter((g) => g.waypointId);
  check(gates.every((g) => wpIds.has(g.waypointId)), `gates still point at real stops (${gates.length} checked)`);

  // 4. lay SOME of a template's days into this trip — the "on top of" case
  await page.locator('.rchip.trip-seat').first().click();
  await page.waitForSelector('.ov-day', { timeout: 10000 });
  const daysBefore = (await lib()).trips.find((r) => r.id === afterCopy.activeId).trip.days.length;
  await page.locator('.ov-day-actions .btn', { hasText: 'Days from a template' }).click();
  await page.waitForSelector('.tpl-insert', { timeout: 6000 });
  await page.locator('.tpl-insert-row').first().click();
  await page.waitForTimeout(300);
  // keep only the first two days of the template
  const boxes = page.locator('.tpl-insert-day input');
  const n = await boxes.count();
  for (let i = 2; i < n; i++) await boxes.nth(i).uncheck();
  await page.selectOption('.tpl-insert select', '0'); // before day 1
  await page.locator('.tpl-insert .btn.gold').click();
  await page.waitForTimeout(800);
  const afterInsert = (await lib()).trips.find((r) => r.id === afterCopy.activeId).trip;
  check(afterInsert.days.length === daysBefore + 2, `two days inserted (${daysBefore} → ${afterInsert.days.length})`);
  check(afterInsert.days[0].date === '2027-05-04' && afterInsert.days[1].date === '2027-05-05',
    `the calendar re-pinned rather than importing old dates (${afterInsert.days[0].date}, ${afterInsert.days[1].date})`);
  const allIds = afterInsert.days.map((d) => d.id);
  check(new Set(allIds).size === allIds.length, 'no id collides with a day already in the trip');
  await page.screenshot({ path: SHOT(`templates-insert-${width}`) });
  // and it is ONE undo
  await page.locator('.masthead .btn', { hasText: 'Undo' }).first().click();
  await page.waitForTimeout(600);
  const undone = (await lib()).trips.find((r) => r.id === afterCopy.activeId).trip;
  check(undone.days.length === daysBefore, 'the whole insertion undoes in one step');

  // 5. Share hands over a file whose template flag survives
  await page.locator('.mast-back').click();
  await page.waitForSelector('.tpl-card', { timeout: 10000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.locator('.tc-share').first().click(),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'rb-tpl-'));
  const file = join(dir, download.suggestedFilename());
  await download.saveAs(file);
  check(/template\.json$/.test(download.suggestedFilename()), `the file names itself a template (${download.suggestedFilename()})`);
  const shared = JSON.parse(await (await import('fs/promises')).readFile(file, 'utf8'));
  check(shared?.meta?.template === true && shared.days.length > 0, 'the shared file carries the template flag');

  // 6. a friend importing it gets a TEMPLATE, not a trip. Fresh browser state.
  const ctx2 = await browser.newContext({ viewport: { width, height: 820 }, acceptDownloads: true });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => console.log('PAGEERROR(2)', e.message));
  await p2.route('**/*', (r) => (r.request().url().includes('localhost:5199') ? r.continue() : r.abort()));
  await p2.goto('http://localhost:5199/');
  await p2.waitForSelector('.trip-card', { timeout: 20000 });
  const before2 = (await p2.evaluate(() => JSON.parse(localStorage.getItem('moto.trips.v1')))).trips.length;
  await p2.locator('.start-card', { hasText: 'Import JSON' }).click();
  await p2.setInputFiles('input[type="file"]', file);
  await p2.waitForTimeout(1200);
  const lib2 = await p2.evaluate(() => JSON.parse(localStorage.getItem('moto.trips.v1')));
  const imported = lib2.trips.find((r) => r.trip?.meta?.template);
  check(!!imported, 'the import lands as a template on the friend\'s shelf');
  check(lib2.trips.length === before2 + 1 && lib2.activeId !== imported?.id,
    'importing a template does not hijack the working trip');
  check(await p2.locator('.tpl-card').count() === 1, 'and it shows under Your templates');
  await p2.screenshot({ path: SHOT(`templates-imported-${width}`) });
  await ctx2.close();

  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
