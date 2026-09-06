// Oversized-proposal card at 375px: buttons must stay on screen, ops scroll.
import { chromium } from '../../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', (r) => (r.request().url().includes('localhost:5199') ? r.continue() : r.abort()));
await page.goto('http://localhost:5199/');
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForTimeout(800);
// open the Copilot dock
await page.click('.dock-fab');
await page.waitForSelector('.chat-panel', { timeout: 8000 });
// inject a 30-op proposal through the real reducer
await page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('moto.trips.v1'));
  const rec = lib.trips.find((r) => r.id === lib.activeId);
  const dayId = rec.trip.days[0].id;
  const ops = Array.from({ length: 30 }, () => ({ op: 'set_day_field', dayId, field: 'depart', value: '8:00 AM' }));
  window.__dispatch({ type: 'set_proposal', proposal: { summary: 'A very large restructure proposal to stress the card layout on a phone screen.', saveAs: 'Stress test', ops } });
});
await page.waitForSelector('.proposal', { timeout: 5000 });
await page.waitForTimeout(400);
const r = await page.evaluate(() => {
  const apply = document.querySelector('.proposal .p-actions .btn');
  const ul = document.querySelector('.proposal ul');
  const input = document.querySelector('.chat-input textarea');
  const b = apply.getBoundingClientRect();
  return {
    applyBottom: Math.round(b.bottom), applyH: Math.round(b.height),
    viewport: window.innerHeight,
    ulScrolls: ul.scrollHeight > ul.clientHeight + 4,
    inputVisible: input ? input.getBoundingClientRect().bottom <= window.innerHeight + 1 : false,
  };
});
const ok = r.applyBottom <= r.viewport && r.ulScrolls && r.inputVisible;
console.log(`${ok ? 'PASS' : 'FAIL'} proposal card: apply bottom ${r.applyBottom}/${r.viewport}px, ops scroll=${r.ulScrolls}, composer visible=${r.inputVisible}`);
await page.screenshot({ path: './shots/proposal-mobile.png' });
// "Apply as new trip": ops land on a CLONE that becomes its own record
await page.locator('.proposal .p-actions .btn', { hasText: 'Apply as new trip' }).click();
await page.waitForTimeout(800);
const fork = await page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('moto.trips.v1'));
  const rec = lib.trips.find((r) => r.id === lib.activeId);
  return { trips: lib.trips.length, activeName: rec.name, title: rec.trip.meta.title, depart: rec.trip.days[0].depart, origDepart: lib.trips[0].trip.days[0].depart };
});
const forkOk = fork.trips === 2 && fork.activeName === 'Stress test' && fork.depart === '8:00 AM' && fork.origDepart !== '8:00 AM';
console.log(`${forkOk ? 'PASS' : 'FAIL'} apply-as-new-trip: ${fork.trips} trips, active "${fork.activeName}", fork depart ${fork.depart}, original depart ${fork.origDepart}`);
await browser.close();
process.exit(ok && forkOk ? 0 : 1);
