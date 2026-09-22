// Saved places, lists and share links (Sep 22, 2026).
//
// Owner: "you can already drop a pin but to save the location as favorite or a
// list and then share locations to someone with link and they can click and
// open in their roadbook". This drives the whole loop at a phone and a desktop
// width:
//
//   drop a pin → ✓ → Save → Favorites + a NEW list + a note → it is on the map
//   and in the library's Saved row → the list opens, framed → Share list → a
//   short link → a SECOND rider (a fresh browser, never been here) opens it →
//   no front door in the way, the places on their map → Save them → they are
//   in that rider's own places, in a list with the sharer's name.
//
// The share function is the REAL one, through the dev server (its in-memory
// store stands in for Netlify Blobs locally). Mapbox, reverse-geocode and
// Places are mocked.
//
//   npm run dev    # :5199 (RB_PORT overrides)
//   node tools/sims/saved-places-check.mjs

import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';
import { seedRideAck } from './fixtures/ride-ack.mjs';

const PORT = process.env.RB_PORT ?? '5199';
const BASE = `http://localhost:${PORT}`;
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const ME = { lat: 44.02, lng: -108.01 };
const PIN = { lat: 44.03, lng: -107.99 };
const PIN2 = { lat: 44.05, lng: -107.95 };
const GEO = { name: 'US-14A, Lovell', detail: 'US-14A, Lovell, WY 82431, USA', road: 'US-14A', locality: 'Lovell', source: 'geocode' };

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function newPage(width, { guest = true } = {}) {
  const phone = width < 820;
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: phone, isMobile: phone, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes('/.netlify/functions/reverse-geocode')) return r.fulfill({ json: GEO });
    if (u.includes('/.netlify/functions/nearby-places')) return r.fulfill({ json: [] });
    if (u.includes('/.netlify/functions/place-details')) return r.fulfill({ status: 404, json: {} });
    if (u.includes(`localhost:${PORT}`)) return r.continue();
    return r.abort();
  });
  await page.addInitScript((me) => {
    const stub = { getCurrentPosition: (ok) => ok({ coords: { latitude: me.lat, longitude: me.lng, accuracy: 5, speed: 0, heading: 0 }, timestamp: Date.now() }), watchPosition: () => 1, clearWatch: () => {} };
    Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
  }, ME);
  if (guest) await seedRideAck(page);
  return { ctx, page, errors, phone };
}

const openHome = async (page) => {
  await page.goto(`${BASE}/`);
  const g = page.locator('.land-skip');
  if (await g.isVisible().catch(() => false)) await g.click();
  await page.waitForSelector('.home-map', { timeout: 15000 });
};
const dropAndConfirm = async (page, pt) => {
  await page.evaluate((p) => window.__homePress(p), pt);
  await page.waitForSelector('.drop-pin', { state: 'attached', timeout: 6000 });
  await page.waitForFunction(() => /US-14A/.test(document.querySelector('.hm-drop-hint')?.innerText ?? ''), null, { timeout: 6000 }).catch(() => {});
  await page.locator('.drop-pin .dp-act.confirm').click();
  await page.waitForSelector('.hm-place.placed', { timeout: 6000 });
};
const profileOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('moto.profile.v1') || '{}'));
const openLibrary = async (page, phone) => {
  if (phone) {
    // the phone's sheet is the library at peek; make sure it is up far enough to hold it
    const st = await page.locator('.hm-sheet').getAttribute('data-state');
    if (st === 'min') await page.locator('.hm-handle').click();
  } else {
    const on = await page.locator('.hm-tripsbtn').getAttribute('aria-pressed');
    if (on !== 'true') await page.locator('.hm-tripsbtn').click();
  }
  await page.waitForSelector('.hm-saved', { timeout: 5000 });
};

let shareUrl = null;

for (const width of [375, 1280]) {
  console.log(`\n── ${width < 820 ? 'phone' : 'desktop'} (${width}px) ──`);
  const { ctx, page, errors, phone } = await newPage(width);
  await openHome(page);
  await page.evaluate(() => localStorage.removeItem('moto.profile.v1'));
  await openHome(page);

  await openLibrary(page, phone);
  check(/Save places you ride to/.test(await page.locator('.hm-saved').innerText()), 'with nothing saved, the library says how to save and share');
  if (!phone) await page.locator('.hm-tripsbtn').click(); // the drawer closes again

  // 1. drop a pin, ✓, and the card offers Save and Share
  await dropAndConfirm(page, PIN);
  const btns = await page.locator('.hm-place .btn:visible').allInnerTexts();
  check(btns.some((b) => /Save/.test(b)) && btns.some((b) => /^Share$/.test(b.trim())), `a dropped pin's card offers Save and Share (${btns.join(' · ')})`);

  // 2. the Save sheet: Favorites on by default, a new list, a name, a note
  await page.locator('.hm-place .btn:visible', { hasText: 'Save' }).first().click();
  await page.waitForSelector('.sv-sheet');
  const favOn = await page.locator('.sv-toggle', { hasText: 'Favorites' }).getAttribute('aria-checked');
  check(favOn === 'true', 'a first save lands in Favorites unless the rider says otherwise');
  const nameVal = await page.locator('.sv-sheet .fld input').first().inputValue();
  check(/US-14A, Lovell/.test(nameVal), `the name starts as what the pin resolved to (${nameVal})`);
  await page.locator('.sv-sheet .fld input').first().fill('Canyon pullout');
  await page.locator('.sv-add').click();
  await page.locator('.sv-new input').fill('Photo spots');
  await page.locator('.sv-new .btn').click();
  check(await page.locator('.sv-toggle', { hasText: 'Photo spots' }).getAttribute('aria-checked') === 'true', 'a list made in the sheet is ticked straight away');
  await page.locator('.sv-sheet textarea').fill('Morning light, room for 4 bikes');
  const sheetFits = await page.evaluate(() => { const m = document.querySelector('.modal.sheet'); return m.scrollWidth <= m.clientWidth + 1 && m.getBoundingClientRect().right <= innerWidth + 1; });
  check(sheetFits, 'the Save sheet fits the screen with no sideways scroll');
  const small = await page.evaluate(() => [...document.querySelectorAll('.sv-toggle, .sv-add, .modal.sheet .modal-foot .btn')].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim()));
  // 44pt is the TOUCH rule; a desktop's buttons are the app's 38px on purpose
  if (phone) check(small.length === 0, `every control in the sheet is at least 44pt on a phone (${small.join(', ') || 'all'})`);
  await page.screenshot({ path: SHOT(`saved-sheet-${width}`) });
  await page.locator('.modal.sheet .modal-foot .btn.gold').click();
  await page.waitForTimeout(250);
  const toast = await page.locator('.hm-toast').innerText().catch(() => '');
  check(/Saved to Favorites, Photo spots/.test(toast), `a toast says where it went (${toast})`);

  let prof = await profileOf(page);
  const row = prof.places?.find((p) => p.label === 'Canyon pullout');
  const list = prof.lists?.find((l) => l.name === 'Photo spots');
  check(!!row && row.role === 'favorite' && !!list && row.lists?.includes(list.id) && row.placed === 'rider' && /Morning light/.test(row.note ?? ''),
    'the profile holds it: a favorite, in the new list, kept as a placed pin, with its note');
  check(Math.abs(row.lat - PIN.lat) < 1e-4 && Math.abs(row.lng - PIN.lng) < 1e-4, 'at the coordinate the needle was on');

  // 3. the card now says it is saved, and where
  const tag = await page.locator('.hm-place .tag.saved:visible').first().innerText().catch(() => '');
  check(/Saved · Favorites, Photo spots/.test(tag), `the card says it is saved, and in which lists (${tag})`);
  check((await page.locator('.hm-place .btn.hm-keep.on:visible').count()) === 1, 'Save became Saved');
  await page.locator('.hm-place [aria-label="Close"]:visible').first().click();
  await page.waitForTimeout(400);

  // 4. it is a pin on the map, where it was saved
  const pin = await page.evaluate(() => {
    const el = document.querySelector('.pl-pin.pl-cat-saved');
    return el ? { lat: Number(el.dataset.lat), lng: Number(el.dataset.lng), glyph: el.querySelector('.pl-glyph')?.textContent, label: el.querySelector('.pl-label')?.textContent } : null;
  });
  check(!!pin && Math.abs(pin.lat - PIN.lat) < 1e-4 && pin.glyph === '★' && pin.label === 'Canyon pullout', `the saved place is a ★ pin on the map with its name (${JSON.stringify(pin)})`);

  // a second place, into the same list only
  await dropAndConfirm(page, PIN2);
  await page.locator('.hm-place .btn:visible', { hasText: 'Save' }).first().click();
  await page.waitForSelector('.sv-sheet');
  await page.locator('.sv-sheet .fld input').first().fill('Ridge view');
  await page.locator('.sv-toggle', { hasText: 'Favorites' }).click();
  await page.locator('.sv-toggle', { hasText: 'Photo spots' }).click();
  await page.locator('.modal.sheet .modal-foot .btn.gold').click();
  await page.waitForTimeout(250);
  await page.locator('.hm-place [aria-label="Close"]:visible').first().click();
  await page.waitForTimeout(300);
  prof = await profileOf(page);
  check(prof.places.find((p) => p.label === 'Ridge view')?.role === 'saved', 'a place in a list but not Favorites is kept as "saved"');

  // 5. the library's Saved row, and a list that opens framed on the map
  await openLibrary(page, phone);
  const chips = await page.locator('.hm-list-chip').allInnerTexts();
  check(chips.some((c) => /Favorites\s*1/.test(c)) && chips.some((c) => /Photo spots\s*2/.test(c)), `the library shows Favorites 1 and Photo spots 2 (${chips.map((c) => c.replace(/\s+/g, ' ')).join(' | ')})`);
  await page.locator('.hm-list-chip', { hasText: 'Photo spots' }).click();
  await page.waitForSelector('.hm-list');
  const rows = await page.locator('.hm-list-rows li').allInnerTexts();
  check(rows.length === 2 && rows.some((r) => /Canyon pullout/.test(r) && /Morning light/.test(r)), `the list holds both places, with the note (${rows.length})`);
  const onMap = await page.evaluate(() => [...document.querySelectorAll('.pl-pin.pl-cat-saved')].map((e) => e.querySelector('.pl-label')?.textContent).sort());
  check(JSON.stringify(onMap) === JSON.stringify(['Canyon pullout', 'Ridge view']), `the map shows that list's places (${onMap.join(', ')})`);
  // the camera eases there: judge the frame once it has settled, and count a
  // pin under the sheet (phone) or the drawer (desktop) as NOT framed — it is
  // on the map, but hidden
  const frame = (pts) => {
    const map = window.__homeMap; if (!map || map.isMoving()) return null;
    const c = map.getContainer().getBoundingClientRect();
    const sheet = document.querySelector('.hm-sheet.open')?.getBoundingClientRect();
    const top = (document.querySelector('.hm-top')?.getBoundingClientRect().bottom ?? c.top) - c.top;
    const phone = innerWidth < 820;
    const floor = phone && sheet ? sheet.top - c.top : c.height;
    const left = !phone && sheet ? sheet.right - c.left : 0;
    const at = pts.map((p) => map.project([p.lng, p.lat]));
    return { ok: at.every((s) => s.x >= left && s.x <= c.width && s.y >= top && s.y <= floor), at, left, top, floor, zoom: map.getZoom() };
  };
  const framed = await page.waitForFunction(new Function('pts', `return (${frame.toString()})(pts)?.ok`), [PIN, PIN2], { timeout: 5000 }).then(() => true).catch(() => false);
  check(framed, 'and frames them on screen, clear of the sheet or the drawer');
  await page.screenshot({ path: SHOT(`saved-list-${width}`) });

  // a row opens its card, which knows where it is kept
  await page.locator('.hm-list-rows li', { hasText: 'Ridge view' }).locator('button').click();
  await page.waitForSelector('.hm-place', { timeout: 5000 });
  check(/Saved · Photo spots/.test(await page.locator('.hm-place .tag.saved:visible').first().innerText().catch(() => '')), 'a list row opens its card, saved in Photo spots');
  await page.locator('.hm-place [aria-label="Close"]:visible').first().click();
  await page.waitForSelector('.hm-list', { timeout: 5000 });
  check(true, 'closing the card goes back to the list');

  // 6. Share the list: a short link, copyable
  await page.locator('.hm-list-actions .btn', { hasText: 'Share list' }).click();
  await page.waitForSelector('.share-sheet');
  await page.waitForFunction(() => /#places=/.test(document.querySelector('.share-sheet .fld input')?.value ?? ''), null, { timeout: 8000 });
  const url = await page.locator('.share-sheet .fld input').inputValue();
  check(/^http:\/\/localhost:\d+\/#places=p[a-z0-9]{12}$/.test(url), `Share makes a SHORT link (${url})`);
  check(/2 places/.test(await page.locator('.share-sheet').innerText()), 'the sheet says what is being shared');
  await page.locator('.modal.sheet .modal-foot .btn', { hasText: 'Copy link' }).click();
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  check(clip === url, 'Copy link puts that link on the clipboard');
  await page.screenshot({ path: SHOT(`saved-share-${width}`) });
  await page.locator('.modal.sheet .modal-head .btn').click();
  shareUrl = url;

  // 7. search: the saved places answer first
  await page.locator('.hm-list-back').click();
  await page.locator('.hm-top .hm-pill').click();
  await page.waitForSelector('.hm-saved-results', { timeout: 5000 });
  check((await page.locator('.hm-saved-results li').count()) === 2, 'an empty search offers the saved places first');
  await page.locator('.hm-input').fill('ridge');
  await page.waitForTimeout(200);
  const hits = await page.locator('.hm-saved-results li').allInnerTexts();
  check(hits.length === 1 && /Ridge view/.test(hits[0]), 'typing matches the saved places by name, before any lookup');
  await page.keyboard.press('Escape');

  check(errors.length === 0, `no page errors (${errors.join('; ') || 'none'})`);
  await ctx.close();
}

// ── the other rider: a fresh browser, never been to Roadbook ──
console.log('\n── the rider the link was sent to ──');
{
  const plain = await newPage(375, { guest: false });
  await plain.page.goto(`${BASE}/`);
  await plain.page.waitForTimeout(1500);
  const gate = await plain.page.locator('.land-skip').isVisible().catch(() => false);
  await plain.ctx.close();

  const { ctx, page, errors } = await newPage(375, { guest: false });
  await page.goto(shareUrl);
  await page.waitForSelector('.hm-list', { timeout: 15000 });
  check(!(await page.locator('.land-skip').isVisible().catch(() => false)),
    `the link opens straight onto the map — ${gate ? 'the front door a plain visit shows is skipped' : 'no front door on this build'}`);
  // innerText follows text-transform, and the kicker is set in capitals
  check(/Shared with you/i.test(await page.locator('.hm-list').innerText()) && /Photo spots/.test(await page.locator('.hm-list-title').innerText()), 'the sheet says it was shared, under the list\'s own name');
  check(!/#places=/.test(await page.evaluate(() => location.hash)), 'the link is cleared from the address bar, so a reload does not reopen it');
  // the pins land once the map exists, a beat after the sheet
  await page.waitForFunction(() => document.querySelectorAll('.pl-pin.pl-cat-shared').length >= 2, null, { timeout: 8000 }).catch(() => {});
  const shared = await page.evaluate(() => [...document.querySelectorAll('.pl-pin.pl-cat-shared')].map((e) => e.querySelector('.pl-label')?.textContent).sort());
  check(JSON.stringify(shared) === JSON.stringify(['Canyon pullout', 'Ridge view']), `the shared places are on their map (${shared.join(', ')})`);
  check(/Morning light/.test(await page.locator('.hm-list').innerText()), 'with the sharer\'s note');
  // framed on a COLD start: the link asks before the map exists
  const coldFramed = await page.waitForFunction((pts) => {
    const map = window.__homeMap; if (!map || map.isMoving()) return false;
    const c = map.getContainer().getBoundingClientRect();
    const sheetTop = document.querySelector('.hm-sheet')?.getBoundingClientRect().top ?? c.bottom;
    const top = (document.querySelector('.hm-top')?.getBoundingClientRect().bottom ?? c.top) - c.top;
    return pts.every((p) => { const s = map.project([p.lng, p.lat]); return s.x >= 0 && s.x <= c.width && s.y >= top && s.y <= sheetTop - c.top - 30; });
  }, [PIN, PIN2], { timeout: 6000 }).then(() => true).catch(() => false);
  check(coldFramed, 'and framed on their screen above the sheet, though the link beat the map to it');
  await page.screenshot({ path: SHOT('saved-received-375') });

  await page.locator('.hm-list-actions .btn.gold', { hasText: 'Save them to my places' }).click();
  await page.waitForTimeout(400);
  const prof = await profileOf(page);
  const theirList = prof.lists?.find((l) => l.name === 'Photo spots');
  const theirs = (prof.places ?? []).filter((p) => theirList && p.lists?.includes(theirList.id)).map((p) => p.label).sort();
  check(JSON.stringify(theirs) === JSON.stringify(['Canyon pullout', 'Ridge view']), `Save puts them in THIS rider's places, in a list named Photo spots (${theirs.join(', ')})`);
  check(/Saved to Photo spots/.test(await page.locator('.hm-toast').innerText().catch(() => '')), 'and says so');
  check(/^Saved$/i.test((await page.locator('.hm-list-title .mono').first().innerText()).trim()) && !/Shared with you/i.test(await page.locator('.hm-list').innerText()), 'the sheet is now their own saved list');

  // a link that points at nothing says so instead of failing silently
  await page.goto(`${BASE}/#places=pzzzzzzzzzzzz`);
  const dead = await page.waitForFunction(() => /no places behind it/i.test(document.querySelector('.hm-list')?.innerText ?? ''), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check(dead, 'a dead link says it has no places behind it');
  check(errors.length === 0, `no page errors (${errors.join('; ') || 'none'})`);
  await ctx.close();
}

await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
