// Settings is one scrolled page, not nine tabs (owner, Sep 13 2026: "make it
// scrollable down. having to hit buttons for each is annoying"), and the
// buttons are big enough for a glove ("like the X button").
//   npm run dev    # :5199
//   node tools/sims/settings-scroll-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
for (const width of [375, 1280]) {
  console.log(`\n── ${width}px ──`);
  const phone = width < 820;
  const ctx = await browser.newContext({ viewport: { width, height: 812 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/*', (r) => { const u = r.request().url(); if (routeMapbox(r)) return undefined; if (isMockTile(u)) return r.fulfill({ status: 204 }); if (u.includes('localhost:5199')) return r.continue(); return r.abort(); });
  await page.goto('http://localhost:5199/');
  const guest = page.locator('.land-skip'); if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.home-map', { timeout: 15000 });
  await page.locator('.hm-round[aria-label="Settings"]').click();
  await page.waitForSelector('.modal.settings', { timeout: 8000 });
  const st = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.set-block')].map((b) => b.dataset.set);
    const x = document.querySelector('.modal .sheet-x')?.getBoundingClientRect();
    const tabs = document.querySelector('.set-tabs').getBoundingClientRect();
    const modal = document.querySelector('.modal.settings');
    return { blocks, x: x ? { w: x.width, h: x.height } : null, tabsTop: tabs.top, modalTop: modal.getBoundingClientRect().top, scrollable: modal.scrollHeight > modal.clientHeight, tabBtn: Math.min(...[...document.querySelectorAll('.set-tabs button')].map((b) => b.getBoundingClientRect().height)) };
  });
  check(st.blocks.length === 9 && st.blocks[0] === 'account' && st.blocks[8] === 'about', `all nine sections are on one page (${st.blocks.join(' · ')})`);
  check(st.scrollable, 'the page scrolls');
  if (phone) check(st.x && st.x.w >= 48 && st.x.h >= 48, `the ✕ is glove-sized (${Math.round(st.x?.w)}×${Math.round(st.x?.h)})`);
  if (phone) check(st.tabBtn >= 44, `the jump links are ≥44pt (${Math.round(st.tabBtn)})`);
  // a jump link scrolls to its section; the strip stays visible
  await page.locator('.set-tabs button', { hasText: /^Data$/ }).click();
  await page.waitForFunction(() => { const b = document.getElementById('set-data').getBoundingClientRect(); const t = document.querySelector('.set-tabs').getBoundingClientRect(); return Math.abs(b.top - t.bottom) < 24; }, null, { timeout: 4000 }).catch(() => {});
  const j = await page.evaluate(() => { const b = document.getElementById('set-data').getBoundingClientRect(); const tabs = document.querySelector('.set-tabs').getBoundingClientRect(); const modal = document.querySelector('.modal.settings').getBoundingClientRect(); return { top: b.top, tabsBottom: tabs.bottom, tabsTop: tabs.top, modalTop: modal.top, active: document.querySelector('.set-tabs button.active')?.textContent }; });
  check(j.top >= j.tabsBottom - 8 && j.top < j.tabsBottom + 120, `Data jumps under the sticky strip (section top ${Math.round(j.top)}, strip bottom ${Math.round(j.tabsBottom)})`);
  check(Math.abs(j.tabsTop - j.modalTop) < 40, 'the strip stays pinned to the top while scrolled');
  check(/Data/.test(j.active ?? ''), `the strip follows the scroll (${j.active})`);
  await ctx.close();
}
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
