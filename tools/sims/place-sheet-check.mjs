// Roadbook's own place page (owner, Sep 13 2026: "why would we link out to
// Google Maps? we should have our own detail page built like Google's").
// A tapped POI and a picker row both open PlaceSheet: a photo (one request,
// on open), rating, price, open now + today's hours, Google's summary, the
// weekly table with today bold, address, tap-to-call, website — and NO link
// out. nearby-places / place-details / place-photo are mocked; the real
// thing is verified locally with GOOGLE_MAPS_API_KEY.
//
//   npm run dev    # :5199
//   node tools/sims/place-sheet-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { normalizePlace } from '../../netlify/functions/place-details.mjs';
import { todayIndex, hoursOnly } from '../../src/engine/places.js';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const HOURS = ['Monday: 7:00 AM – 8:00 PM', 'Tuesday: 7:00 AM – 8:00 PM', 'Wednesday: 7:00 AM – 8:00 PM', 'Thursday: 7:00 AM – 8:00 PM', 'Friday: 7:00 AM – 9:00 PM', 'Saturday: 8:00 AM – 9:00 PM', 'Sunday: Closed'];
const GOOGLE_ROW = { id: 'g-cowboy', name: 'Cowboy Cafe', detail: '138 N Main St, Sheridan, WY 82801, USA', lat: 44.0002, lng: -107.9997, rating: 4.5, userRatingCount: 1308, priceLevel: 'PRICE_LEVEL_MODERATE', status: 'OPERATIONAL', openNow: true, primaryType: 'restaurant', types: ['restaurant', 'cafe'], hours: HOURS, googleMapsUri: 'https://maps.google.com/?cid=1' };
const RAW_DETAILS = {
  id: 'g-cowboy', displayName: { text: 'Cowboy Cafe' }, formattedAddress: GOOGLE_ROW.detail, location: { latitude: GOOGLE_ROW.lat, longitude: GOOGLE_ROW.lng },
  types: ['restaurant'], primaryType: 'restaurant', businessStatus: 'OPERATIONAL', rating: 4.5, userRatingCount: 1308, priceLevel: 'PRICE_LEVEL_MODERATE',
  googleMapsUri: 'https://maps.google.com/?cid=1', websiteUri: 'https://www.cowboycafewyo.com/', nationalPhoneNumber: '(307) 672-2391',
  regularOpeningHours: { weekdayDescriptions: HOURS, periods: [] }, currentOpeningHours: { openNow: true },
  editorialSummary: { text: 'Down-home diner known for chicken-fried steak and pie.' },
  photos: [{ name: 'places/g-cowboy/photos/p1', widthPx: 1600, heightPx: 1200, authorAttributions: [{ displayName: 'Cowboy Cafe', uri: 'https://maps.google.com/maps/contrib/1' }] }, { name: 'places/g-cowboy/photos/p2' }, { name: 'places/g-cowboy/photos/p3' }],
  reviews: [
    { rating: 5, relativePublishTimeDescription: '2 weeks ago', text: { text: 'Chicken-fried steak the size of the plate. Bikes welcome out front.' }, authorAttribution: { displayName: 'Dale R.', uri: 'https://www.google.com/maps/contrib/2' } },
    { rating: 4, relativePublishTimeDescription: 'a month ago', text: { text: 'Good pie, slow on a Saturday.' }, authorAttribution: { displayName: 'Marta K.' } },
    { rating: 5, relativePublishTimeDescription: '3 months ago', text: { text: 'Best breakfast in Sheridan.' }, authorAttribution: { displayName: 'Jo' } },
  ],
  dineIn: true, takeout: true, delivery: false, reservable: false, servesBreakfast: true, goodForGroups: true, restroom: true,
  accessibilityOptions: { wheelchairAccessibleEntrance: true },
  parkingOptions: { freeStreetParking: true },
};

// 0. the details normaliser, pure
{
  const d = normalizePlace(RAW_DETAILS);
  check(d.name === 'Cowboy Cafe' && d.phone === '(307) 672-2391' && d.websiteUri === 'https://www.cowboycafewyo.com/' && d.summary?.startsWith('Down-home'), 'details carry phone, website and the editorial summary');
  check(d.hours.length === 7 && d.openNow === true && d.rating === 4.5 && d.userRatingCount === 1308, 'hours, open-now and rating come through in the search-row shape');
  check(d.photos.length === 3 && d.photos[0].name === 'places/g-cowboy/photos/p1' && d.photos[0].by[0].name === 'Cowboy Cafe' && d.photos[0].by[0].uri, 'photos carry their names and author attribution');
  check(d.reviews.length === 3 && d.reviews[0].by === 'Dale R.' && d.reviews[0].rating === 5 && /Chicken-fried/.test(d.reviews[0].text), 'reviews carry rating, author and text');
  check(d.amenities.some((a) => a.label === 'Dine-in' && a.ok) && d.amenities.some((a) => a.label === 'Delivery' && !a.ok) && d.amenities.some((a) => a.label === 'Wheelchair entrance' && a.ok) && d.amenities.some((a) => a.label === 'Free parking' && a.ok) && !d.amenities.some((a) => a.label === 'Dogs OK'), 'amenities list only what Google states, true or false');
  check(normalizePlace({ id: 'x' }).photos.length === 0 && normalizePlace({ id: 'x' }).hours === null, 'a bare place normalises without throwing');
  check(hoursOnly('Monday: 7:00 AM – 8:00 PM') === '7:00 AM – 8:00 PM' && todayIndex(new Date('2026-09-14T12:00:00')) === 0 && todayIndex(new Date('2026-09-13T12:00:00')) === 6, 'today indexes Monday-first like Google');
}

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const enc6 = (pts) => {
  let out = '', plat = 0, plng = 0;
  const enc = (v) => { let s = ''; v = v < 0 ? ~(v << 1) : (v << 1); while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lng, lat] of pts) { const a = Math.round(lat * 1e6), b = Math.round(lng * 1e6); out += enc(a - plat) + enc(b - plng); plat = a; plng = b; }
  return out;
};
const A = [-108.0, 44.0], B = [-107.95, 44.06], C = [-107.88, 44.10];
function valhalla(body) {
  const locs = body.locations.map((l) => [l.lon, l.lat]);
  const legs = [];
  for (let i = 0; i < locs.length - 1; i++) {
    const a = locs[i], b = locs[i + 1];
    legs.push({ shape: enc6([a, lerp(a, b, 0.5), b]), summary: { length: 5, time: 360 }, maneuvers: [
      { type: 1, instruction: 'Ride.', street_names: ['Road'], length: 5, time: 360, begin_shape_index: 0 },
      { type: 4, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: 2 },
    ] });
  }
  return { trip: { legs, summary: { length: 5 * legs.length, time: 360 * legs.length }, status: 0, units: 'miles' } };
}

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function run(width, label) {
  console.log(`\n── ${label} (${width}px) ──`);
  const phone = width < 820;
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: phone, isMobile: phone }); // a phone: (pointer: coarse) → the 44pt rules
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('PAGEERROR', e.message); });
  const hits = { details: 0, photo: 0, nearby: 0 };
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes('/.netlify/functions/nearby-places')) { hits.nearby++; const b = r.request().postDataJSON(); return r.fulfill({ json: /cowboy/i.test(b.query ?? '') || b.category === 'food' ? [GOOGLE_ROW] : [] }); }
    if (u.includes('/.netlify/functions/place-details')) { hits.details++; return r.fulfill({ json: normalizePlace(RAW_DETAILS) }); }
    if (u.includes('/.netlify/functions/place-photo')) { hits.photo++; return r.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 }); }
    if (u.includes('/.netlify/functions/google-route')) return r.fulfill({ status: 501, json: { error: 'no key' } });
    if (u.includes('localhost:5199')) return r.continue();
    if (u.includes('valhalla1.openstreetmap.de/route')) return r.fulfill({ json: valhalla(r.request().postDataJSON()) });
    if (u.includes('router.project-osrm.org')) return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
    return r.abort();
  });
  await page.goto('http://localhost:5199/');
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.trip-card', { timeout: 15000 });
  { const tb = page.locator('.hm-tripsbtn'); if (await tb.isVisible().catch(() => false)) { await tb.click(); await page.waitForTimeout(400); } } // the desktop home keeps the library in a closed drawer
  await page.click('.trip-card');
  await page.waitForSelector('.modebar', { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const mk = (id, name, lat, lng, extra = {}) => ({ id, kind: 'via', name, lat, lng, mile: null, note: '', ...extra });
    window.__dispatch({
      type: 'create_trip', name: 'SHEET TEST',
      trip: {
        meta: { title: 'SHEET TEST', subtitle: '', summary: '', riders: 1, startDate: '2026-08-12', fuelRule: '', range: 200, roster: [] },
        days: [{
          id: 'q1', dow: 'Wed', date: '2026-08-12', title: 'Sheet day', phase: 'outbound',
          miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '', constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
          lodging: { status: 'none', name: '', where: '', note: '' },
          waypoints: [mk('qa', 'Basecamp', 44.0, -108.0), mk('qb', 'Granite Diner', 44.06, -107.95, { dwell: 30 }), mk('qc', 'End Lodge', 44.10, -107.88)],
        }],
      },
    });
  });
  await page.waitForTimeout(1200);
  const lib = () => page.evaluate(() => { const l = JSON.parse(localStorage.getItem('moto.trips.v1')); return l.trips.find((r) => r.id === l.activeId).trip; });
  const today = todayIndex();

  // 1. a POI tap opens the sheet, not a card with a Maps link
  await page.locator('.ribbon .rchip:not(.trip-seat)').first().click();
  await page.waitForSelector('.wp-row', { timeout: 8000 });
  if (phone) { await page.locator('.panel-tab').click().catch(() => {}); await page.waitForTimeout(300); }
  await page.evaluate(() => window.__poiTap({ properties: { name: 'Cowboy Cafe', class: 'food_and_drink', maki: 'restaurant' }, geometry: { coordinates: [-108.0, 44.0] } }));
  await page.waitForSelector('.place-sheet', { timeout: 6000 });
  await page.waitForFunction(() => !!document.querySelector('.place-sheet .ps-hero img'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  const s1 = await page.evaluate(() => {
    const el = document.querySelector('.place-sheet');
    const img = el.querySelector('.ps-hero img');
    const rows = [...el.querySelectorAll('.ps-hours li')];
    return {
      text: el.innerText, img: !!img && img.naturalWidth > 0, credit: el.querySelector('.ps-credit')?.textContent ?? '',
      todayRow: rows.findIndex((li) => li.classList.contains('today')), rows: rows.length,
      tel: el.querySelector('.ps-contact a[href^="tel:"]')?.getAttribute('href') ?? '', site: el.querySelector('.ps-contact a[href^="http"]')?.getAttribute('href') ?? '',
      mapsOut: [...el.querySelectorAll('a')].filter((a) => /google\.com\/maps\/?\?|maps\.google\.com\/\?/.test(a.href) && !a.classList.contains('ps-credit')).length,
      inView: el.getBoundingClientRect().bottom <= innerHeight + 1 && el.getBoundingClientRect().top >= -1, box: { top: Math.round(el.getBoundingClientRect().top), bottom: Math.round(el.getBoundingClientRect().bottom), h: innerHeight },
      foot: (() => { el.scrollTop = el.scrollHeight; const r = el.querySelector('.ps-foot .btn.gold')?.getBoundingClientRect(); el.scrollTop = 0; return r ? { bottom: r.bottom, height: r.height } : null; })(),
    };
  });
  check(/Cowboy Cafe/.test(s1.text) && /★ 4\.5/.test(s1.text) && /\(1308\)/.test(s1.text) && /\$\$/.test(s1.text) && /Open now/.test(s1.text), 'name, rating with count, price and open-now on the sheet');
  check(s1.img && /Photo: Cowboy Cafe/.test(s1.credit), 'the first photo loads with its author credit');
  const rich = await page.evaluate(() => ({ shots: document.querySelectorAll('.place-sheet .ps-shot').length, chips: [...document.querySelectorAll('.place-sheet .ps-chip')].map((c) => c.textContent), reviews: document.querySelectorAll('.place-sheet .ps-review').length, more: document.querySelector('.place-sheet .ps-reviews .btn')?.textContent ?? '' }));
  check(rich.shots === 3, `a photo strip, not one photo (${rich.shots})`);
  check(rich.chips.some((c) => /✓ Dine-in/.test(c)) && rich.chips.some((c) => /✓ Wheelchair entrance/.test(c)) && rich.chips.some((c) => /✕ Delivery/.test(c)), `the practical facts as chips (${rich.chips.slice(0, 4).join(', ')}…)`);
  check(rich.reviews === 2 && /More reviews \(1\)/.test(rich.more), 'two reviews shown, the rest behind More reviews');
  await page.locator('.place-sheet .ps-reviews .btn').click();
  check(await page.locator('.place-sheet .ps-review').count() === 3 && /Dale R\./.test(await page.locator('.place-sheet .ps-review').first().innerText()), 'More reviews shows them all, each with its author');
  check(new RegExp(`Today ${hoursOnly(HOURS[today]).replace(/[–]/g, '.')}`).test(s1.text.replace(/[–]/g, '.')), `today's hours are on the stat row (${hoursOnly(HOURS[today])})`);
  check(s1.rows === 7 && s1.todayRow === today, 'the weekly table lists seven days with today bold');
  check(/Down-home diner/.test(s1.text), "Google's one-line summary is shown");
  check(/138 N Main St/.test(s1.text) && s1.tel === 'tel:3076722391' && s1.site === 'https://www.cowboycafewyo.com/', 'address, tap-to-call and the website are real links');
  check(s1.mapsOut === 0 && !/\bMaps\b/.test(s1.text), 'no link out to Google Maps anywhere on the sheet');
  check(/Place facts, photos and reviews from Google/i.test(s1.text), 'Google is credited for the facts, the photos and the reviews');
  check(hits.details === 1 && hits.photo >= 1 && hits.photo <= 3, `one details call and at most three photo requests per open (${hits.details}/${hits.photo})`);
  check(s1.inView && s1.foot && s1.foot.bottom <= 821 && s1.foot.height >= (phone ? 44 : 30), `the sheet fits the viewport and scrolls to its action (sheet ${s1.box.top}–${s1.box.bottom} of ${s1.box.h}, foot bottom ${Math.round(s1.foot?.bottom)} h ${Math.round(s1.foot?.height)})`);
  await page.screenshot({ path: SHOT(`place-sheet-${width}`) });
  // Add from the sheet lands a verified stop
  await page.locator('.place-sheet .ps-foot .btn.gold').click();
  await page.waitForTimeout(600);
  let trip = await lib();
  const added = trip.days[0].waypoints.find((w) => w.name === 'Cowboy Cafe');
  check(!!added && added.placeId === 'g-cowboy' && added.verified === 'google', 'Add from the sheet lands a VERIFIED stop with Google\'s identity');
  check(await page.locator('.place-sheet').count() === 0, 'the sheet closes on add');

  // 2. reopening the same place is free
  await page.evaluate(() => window.__poiTap({ properties: { name: 'Cowboy Cafe', class: 'food_and_drink', maki: 'restaurant' }, geometry: { coordinates: [-108.0, 44.0] } }));
  await page.waitForSelector('.place-sheet', { timeout: 6000 });
  await page.waitForTimeout(600);
  check(hits.details === 1, 'the second open reads the cached details, no new call');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(await page.locator('.place-sheet').count() === 0, 'Escape closes it');

  // 3. a POI with no listing still gets the sheet, with the honest note and no facts
  await page.evaluate(() => window.__poiTap({ properties: { name: 'Nowhere Cafe', class: 'food_and_drink', maki: 'cafe' }, geometry: { coordinates: [-108.0, 44.0] } }));
  await page.waitForSelector('.place-sheet', { timeout: 6000 });
  await page.waitForFunction(() => /No Google listing/.test(document.querySelector('.place-sheet')?.innerText ?? ''), null, { timeout: 8000 });
  const s3 = await page.evaluate(() => ({ text: document.querySelector('.place-sheet').innerText, img: !!document.querySelector('.place-sheet .ps-hero') }));
  check(/Nowhere Cafe/.test(s3.text) && !s3.img && !/Google$/.test(s3.text) && !/★/.test(s3.text), 'an unlisted POI gets a plain sheet: name, note, no photo, no borrowed facts');
  await page.keyboard.press('Escape');

  // 4. the picker's Details opens the same sheet, and its action is the picker's
  if (await page.locator('.main').getAttribute('data-panel') === 'closed') {
    await page.locator('.modebar button', { hasText: 'Plan' }).evaluate((el) => el.click());
    await page.waitForFunction(() => document.querySelector('.main')?.dataset.panel === 'open', null, { timeout: 5000 }).catch(() => {});
  }
  await page.waitForSelector('.place-search .btn', { timeout: 8000 });
  await page.locator('.place-search .btn').click();
  await page.waitForSelector('.nearby', { timeout: 5000 });
  await page.locator('.nb-chip', { hasText: /Food/ }).first().click();
  await page.waitForSelector('.nb-item', { timeout: 8000 });
  await page.locator('.nb-item .nb-main').first().click();
  await page.waitForSelector('.nb-more', { timeout: 6000 });
  check(await page.locator('.nb-more a[href*="google.com"]').count() === 0, 'the picker row has no Maps link either');
  await page.locator('.nb-more button', { hasText: /Details/ }).click();
  await page.waitForSelector('.place-sheet', { timeout: 6000 });
  await page.waitForTimeout(500);
  const s4 = await page.evaluate(() => ({ text: document.querySelector('.place-sheet').innerText, gold: document.querySelector('.place-sheet .ps-foot .btn.gold')?.textContent ?? '' }));
  check(/Cowboy Cafe/.test(s4.text) && /\(307\) 672-2391/.test(s4.text) && /Add to the day/.test(s4.gold), 'Details from the picker: same sheet, the picker\'s own action');
  await page.screenshot({ path: SHOT(`place-sheet-picker-${width}`) });
  const before = (await lib()).days[0].waypoints.length;
  await page.locator('.place-sheet .ps-foot .btn.gold').click();
  await page.waitForTimeout(600);
  trip = await lib();
  check(trip.days[0].waypoints.length === before + 1 && await page.locator('.place-sheet').count() === 0, 'its action adds the stop and closes the sheet');
  check(pageErrors.length === 0, `no page errors (${pageErrors.length})`);
  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
