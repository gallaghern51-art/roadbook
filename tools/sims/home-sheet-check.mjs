// The home sheet answers its handle on EVERY surface (owner, Sep 14 2026, two
// screenshots of the Food picker over Manhattan: "there's a scroller within a
// scroller… and you can't minimize the list to view the map you click it and
// nothing happens").
//
// It did nothing because `.hm-sheet.pick { height: 62% }` and
// `.hm-sheet[data-state='min']` are both (0,2,0) and `.pick` was written after,
// so the surface class won every detent by source order. The state changed —
// the handle's own label flipped — and the sheet never moved. `sheetPx` had the
// same bug in JS, so the fab column ignored the detent too.
//
//   npm run dev    # :5199
//   node tools/sims/home-sheet-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';

let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const ME = { lat: 44.02, lng: -108.01 };
const ROW = (id, name, lat, lng, extra = {}) => ({
  id, name, lat, lng, source: 'google', rating: 4.4, userRatingCount: 120, priceLevel: 2,
  address: `${name}, WY`, primaryType: 'restaurant', types: ['restaurant'], openNow: true, ...extra,
});
const FOOD = ['Cowboy Cafe', 'Pony Bar', 'Granite Diner', 'Bighorn Grill', 'Ten Sleep Kitchen', 'Basin Chophouse']
  .map((n, i) => ROW(`g-${i}`, n, 44.03 + i * 0.01, -107.97 - i * 0.01));

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const PORT = process.env.RB_PORT ?? '5199';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

// a tap on the handle: pointer down and up with no travel, which is what the
// handler reads as a tap rather than a drag
const tapHandle = async (page) => {
  await page.evaluate(() => {
    const el = document.querySelector('.hm-handle');
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 7, bubbles: true, isPrimary: true, pointerType: 'touch' };
    el.dispatchEvent(new PointerEvent('pointerdown', at));
    el.dispatchEvent(new PointerEvent('pointerup', at));
  });
  await page.waitForTimeout(420); // the height transition is 0.25s
};

const geom = (page) => page.evaluate(() => {
  const sh = document.querySelector('.hm-sheet');
  const r = sh.getBoundingClientRect();
  const root = document.querySelector('.home-map');
  const list = document.querySelector('.hm-sheet .nb-list');
  const chips = document.querySelector('.hm-chips');
  const handle = document.querySelector('.hm-handle');
  return {
    state: sh.getAttribute('data-state'),
    cls: sh.className,
    h: Math.round(r.height),
    top: Math.round(r.top),
    vh: innerHeight,
    label: document.querySelector('.hm-handle-txt')?.textContent ?? '',
    handleH: Math.round(handle.getBoundingClientRect().height),
    fabBottom: getComputedStyle(root).getPropertyValue('--hm-sheet').trim(),
    picker: !!document.querySelector('.hm-sheet .nb-chips'),
    rows: document.querySelectorAll('.hm-sheet .nb-list li').length,
    listOverflow: list ? getComputedStyle(list).overflowY : null,
    listMaxH: list ? getComputedStyle(list).maxHeight : null,
    chipTouch: chips ? getComputedStyle(chips).touchAction : null,
  };
});

async function run(width, label) {
  console.log(`\n── ${label} (${width}px) ──`);
  const phone = width < 820;
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message); });
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes('/.netlify/functions/nearby-places')) return r.fulfill({ json: FOOD });
    if (u.includes('/.netlify/functions/place-details')) return r.fulfill({ status: 404, json: {} });
    if (u.includes(`localhost:${PORT}`)) return r.continue();
    return r.abort();
  });
  await page.addInitScript((me) => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (ok) => ok({ coords: { latitude: me.lat, longitude: me.lng, accuracy: 5, speed: 0, heading: 0 }, timestamp: Date.now() }),
        watchPosition: () => 1, clearWatch: () => {},
      },
    });
  }, ME);
  await page.goto(`http://localhost:${PORT}/`);
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.home-map', { timeout: 20000 });
  await page.waitForTimeout(900);

  if (!phone) {
    // on a desktop the sheet is a drawer; the detent matrix is phone-only and
    // must not have leaked into it
    const d = await geom(page);
    check(d.h > 300 && d.top < 200, `desktop keeps the drawer geometry (${d.h}px tall, top ${d.top})`);
    check(errors.length === 0, `no page errors (${errors.length})`);
    await ctx.close();
    return;
  }

  const base = await geom(page);
  check(base.state === 'peek', `the sheet opens at peek (${base.state})`);
  check(base.chipTouch === 'pan-x', `the chip strip is pan-x, so a pinch reaches the map (${base.chipTouch})`);
  check(base.handleH >= 48, `the handle is a glove-sized target (${base.handleH}px)`);

  // open the Food picker
  await page.locator('.hm-chip', { hasText: /Food/i }).first().click();
  await page.waitForSelector('.hm-sheet .nb-list li', { timeout: 15000 });
  await page.waitForTimeout(500);
  const picked = await geom(page);
  check(/\bpick\b/.test(picked.cls), 'the picker is the sheet surface');
  check(picked.rows >= 3, `the picker listed places (${picked.rows})`);
  check(picked.h > base.h + 100, `the picker PEEKS taller than the trips row (${picked.h}px vs ${base.h}px)`);
  check(picked.listOverflow !== 'auto' && picked.listOverflow !== 'scroll',
    `no scroller inside the scroller — the list does not scroll itself (overflow-y ${picked.listOverflow})`);
  check(picked.listMaxH === 'none', `the list is as long as it is (max-height ${picked.listMaxH})`);
  check(/Show the map/i.test(picked.label), `the handle offers the map (“${picked.label.trim()}”)`);

  // THE REPORTED BUG: tap the handle with the picker open
  await tapHandle(page);
  const min = await geom(page);
  check(min.state === 'min', `one tap minimises the picker (${min.state})`);
  check(min.h < picked.h - 200, `the sheet actually MOVED (${picked.h}px → ${min.h}px)`);
  check(min.h <= 140, `the map is the screen (${min.h}px of ${min.vh})`);
  check(min.picker, 'the picker stayed mounted behind the handle');
  check(/Show the list/i.test(min.label), `the handle names what comes back (“${min.label.trim()}”)`);
  check(parseInt(min.fabBottom, 10) <= 140, `the fab column followed the sheet down (--hm-sheet ${min.fabBottom})`);

  // and back
  await tapHandle(page);
  const back = await geom(page);
  check(back.state === 'peek' && Math.abs(back.h - picked.h) < 12, `a second tap brings the list back (${back.h}px)`);
  check(back.rows >= 3, 'the results survived the round trip');

  // a place card answers the handle too — a row EXPANDS, then its action picks
  await page.locator('.hm-sheet .nb-item .nb-main').first().click();
  await page.waitForTimeout(500);
  await page.locator('.hm-sheet .nb-item.open .btn.gold').first().click();
  await page.waitForTimeout(800);
  const card = await geom(page);
  if (/\bplace\b/.test(card.cls)) {
    await tapHandle(page);
    const cmin = await geom(page);
    check(cmin.state === 'min' && cmin.h < card.h, `the place card minimises too (${card.h}px → ${cmin.h}px)`);
    check(/Show the place/i.test(cmin.label), `and names itself (“${cmin.label.trim()}”)`);
  } else {
    check(false, `tapping a row opened the place card (class “${card.cls}”)`);
  }

  check(errors.length === 0, `no page errors (${errors.length})`);
  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
