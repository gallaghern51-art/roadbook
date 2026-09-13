// Plans strip rework: Current chip, drift dot, active-chip behavior, duplicate-trip
// verb, shared-mode group/solo fork with replace_trip broadcast, auto-stash pruning,
// compact day-panel pill, shared proposal card, feasibility table parity.
import { chromium } from '../../node_modules/playwright-core/index.mjs';
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', (r) => (r.request().url().includes('localhost:5199') ? r.continue() : r.abort()));
await page.goto('http://localhost:5199/');
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForTimeout(800);

const lib = () => page.evaluate(() => {
  const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
  return { ...l, rec: l.trips.find((r) => r.id === l.activeId) };
});

// 1. Current chip when nothing active
const curChip = page.locator('.scen-strip .ss-chip.active', { hasText: 'Current' });
check(await curChip.count() === 1, 'Current chip lit when no saved plan is active');

// 2. tapping Current opens the save-as input; save "Solo Thursday"
await curChip.click();
await page.waitForSelector('.ss-name', { timeout: 4000 });
await page.fill('.ss-name', 'Solo Thursday');
await page.locator('.ss-confirm .btn.gold').click();
await page.waitForTimeout(400);
check(await page.locator('.scen-strip .ss-chip.active', { hasText: 'Solo Thursday' }).count() === 1
   && await page.locator('.scen-strip .ss-chip', { hasText: 'Current' }).count() === 0,
  'saving from Current chip names the plan; Current chip retires');

// 3. drift dot + Update bar after an edit
const day0 = (await lib()).rec.trip.days[0].id;
await page.evaluate((d) => window.__dispatch({ type: 'apply_ops', ops: [{ op: 'set_day_field', dayId: d, field: 'depart', value: '7:15 AM' }] }), day0);
await page.waitForTimeout(400);
const activeTxt = await page.locator('.scen-strip .ss-chip.active').textContent();
check(activeTxt.includes('•'), `drift dot on active chip ("${activeTxt}")`);
check(await page.locator('.ss-confirm .btn', { hasText: 'Update' }).count() >= 1, 'Update bar offers to write drift back');

// 4. tapping the ACTIVE chip: Update/Delete/Cancel, no Load
await page.locator('.scen-strip .ss-chip.active').click();
await page.waitForTimeout(300);
const rowBtns = await page.locator('.ss-confirm .btn').allTextContents();
check(!rowBtns.some((b) => b.startsWith('Load')) && rowBtns.some((b) => b.startsWith('Update')),
  `active chip row has no Load (${JSON.stringify(rowBtns)})`);
await page.locator('.ss-confirm .btn', { hasText: 'Update' }).first().click();
await page.waitForTimeout(300);
check(!(await page.locator('.scen-strip .ss-chip.active').textContent()).includes('•'), 'Update clears the drift dot');
await page.screenshot({ path: SHOT('scen-overview') });

// 5. Duplicate trip verb (unshared wording) forks the current plan
const before = (await lib()).trips.length;
await page.locator('.scen-strip .ss-chip.ss-add', { hasText: 'Duplicate trip' }).click();
await page.waitForSelector('.ss-confirm .btn.gold', { timeout: 4000 });
await page.locator('.ss-confirm .btn.gold', { hasText: 'Create my copy' }).click();
await page.waitForTimeout(500);
const afterDup = await lib();
check(afterDup.trips.length === before + 1 && afterDup.rec.name.includes('— copy'),
  `Duplicate trip creates its own record ("${afterDup.rec.name}") and switches to it`);
const originalId = afterDup.trips.find((r) => !r.name.includes('— copy')).id;
await page.evaluate((id) => window.__dispatch({ type: 'switch_trip', id }), originalId);
await page.waitForTimeout(600);

// 6. shared mode: fork question + replace_trip broadcast in the outbox
await page.evaluate(() => window.__dispatch({ type: 'set_remote', remote: { tripId: 'sim-shared', code: 'TEST' } }));
await page.evaluate(() => window.__dispatch({ type: 'save_scenario', name: 'Group plan B' }));
await page.evaluate((d) => window.__dispatch({ type: 'apply_ops', ops: [{ op: 'set_day_field', dayId: d, field: 'depart', value: '9:45 AM' }] }), day0);
await page.waitForTimeout(400);
await page.locator('.scen-strip .ss-chip', { hasText: 'Solo Thursday' }).click();
await page.waitForTimeout(300);
const sharedBtns = await page.locator('.ss-confirm .btn').allTextContents();
check(sharedBtns.some((b) => b.includes('Load for the group')) && sharedBtns.some((b) => b.includes('Just me — new trip')),
  `shared trip forks the decision (${JSON.stringify(sharedBtns)})`);
await page.screenshot({ path: SHOT('scen-shared') });
await page.locator('.ss-confirm .btn.gold', { hasText: 'Load for the group' }).click();
await page.waitForTimeout(500);
const afterLoad = await lib();
const lastBatch = afterLoad.rec.outbox[afterLoad.rec.outbox.length - 1];
check(lastBatch?.ops?.length === 1 && lastBatch.ops[0].op === 'replace_trip' && lastBatch.ops[0].label === 'Solo Thursday'
   && lastBatch.ops[0].trip?.days?.length > 0,
  'group load enqueues a replace_trip op for the sync outbox');
check(afterLoad.rec.trip.days[0].depart === '7:15 AM', 'group load swapped the working plan');

// 7. auto-stash pruning: several dirty switches leave exactly one Auto-saved chip
await page.evaluate((d) => window.__dispatch({ type: 'apply_ops', ops: [{ op: 'set_day_field', dayId: d, field: 'depart', value: '10:10 AM' }] }), day0);
await page.evaluate(() => {
  const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
  const rec = l.trips.find((r) => r.id === l.activeId);
  window.__dispatch({ type: 'load_scenario', id: rec.scenarios.find((s) => s.name === 'Group plan B').id });
});
await page.waitForTimeout(300);
await page.evaluate((d) => window.__dispatch({ type: 'apply_ops', ops: [{ op: 'set_day_field', dayId: d, field: 'depart', value: '11:11 AM' }] }), day0);
await page.evaluate(() => {
  const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
  const rec = l.trips.find((r) => r.id === l.activeId);
  window.__dispatch({ type: 'load_scenario', id: rec.scenarios.find((s) => s.name === 'Solo Thursday').id });
});
await page.waitForTimeout(400);
const stash = (await lib()).rec.scenarios.filter((s) => s.name.startsWith('Auto-saved'));
check(stash.length === 1, `only the latest auto-stash survives (${stash.length})`);

// 8. day panel: compact pill, expands on tap
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
await page.locator('.rchip').nth(4).click();
await page.waitForSelector('.wp-row', { timeout: 8000 });
check(await page.locator('.ss-pill').count() === 1, 'day panel wears the compact pill');
const pillTxt = await page.locator('.ss-pill .ss-cur').textContent();
check(pillTxt.includes('Solo Thursday'), `pill answers "which plan am I on" ("${pillTxt}")`);
await page.screenshot({ path: SHOT('scen-day') });
await page.locator('.ss-pill').click();
await page.waitForTimeout(300);
check(await page.locator('.scen-strip .ss-chips').count() === 1 && await page.locator('.scen-strip .ss-caret').count() >= 1,
  'pill expands to the full strip with a collapse caret');

// 9. shared proposal card: group verbs + note
await page.evaluate((d) => window.__dispatch({
  type: 'set_proposal',
  proposal: { ops: [{ op: 'set_day_field', dayId: d, field: 'depart', value: '8:00 AM' }], summary: 'Depart earlier.', saveAs: 'Early start' },
}), day0);
// The Copilot fab hides behind an open day panel on a phone (App: !isMobile ||
// !panelOpen), and step 8 left the panel open — dismiss it first. Without this
// the sim waits 30s for a fab that is deliberately not there.
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {});
await page.waitForTimeout(400);
await page.locator('.dock-fab').click();
await page.waitForSelector('.proposal', { timeout: 5000 });
const pBtns = await page.locator('.proposal .p-actions .btn').allTextContents();
check(pBtns.some((b) => b.includes('Apply for the group')) && pBtns.some((b) => b.includes('Just me — new trip')),
  `shared proposal card speaks the fork language (${JSON.stringify(pBtns)})`);
check(await page.locator('.proposal .p-note').count() === 1, 'shared proposal card carries the group/solo note');
const pTitle = await page.locator('.proposal .p-title').textContent();
check(pTitle.includes('—') && !pTitle.includes('→'), `proposal title uses an em dash ("${pTitle}")`);
await page.screenshot({ path: SHOT('proposal-shared') });
await page.locator('.proposal .p-actions .btn', { hasText: 'Dismiss' }).click();
await page.locator('.ai-dock .btn, .dock-close, .ai-dock button', { hasText: '✕' }).first().click().catch(() => {});
await page.waitForTimeout(300);

// 10. PREP → Plans card → feasibility parity (Saved plans + shared fork row)
await page.locator('.modebar button', { hasText: 'PREP' }).click().catch(async () => {
  await page.locator('.tabnav button', { hasText: 'Prep' }).click();
});
await page.waitForTimeout(600);
const plansCard = page.locator('.prep-card, .card, button', { hasText: 'Plans' }).first();
check(await page.locator('text=Plans').count() >= 1, 'PREP card renamed to Plans');
await plansCard.click();
await page.waitForTimeout(600);
check(await page.locator('h3', { hasText: 'Saved plans' }).count() === 1, 'feasibility heading says Saved plans');
await page.locator('.scen-table .btn', { hasText: 'Load' }).first().click();
await page.waitForTimeout(300);
const feasBtns = await page.locator('.ss-confirm .btn').allTextContents();
check(feasBtns.some((b) => b.includes('Load for the group')) && feasBtns.some((b) => b.includes('Just me — new trip')),
  `feasibility table asks the same fork question (${JSON.stringify(feasBtns)})`);
await page.screenshot({ path: SHOT('scen-feas') });

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
