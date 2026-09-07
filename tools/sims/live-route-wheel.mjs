// LIVE route-wheel check — touch, phone width, no mocked network.
//
// The companion to live-route-drag.mjs: same real sign-in, same real Valhalla,
// same reported Weehawken -> Nyack road, but driven the way a rider on a phone
// drives it. Tap the route, drag the wheel's grip onto the road you wanted,
// press confirm. Adjust and confirm are separate acts, so this also has to
// prove that a tap alone changes nothing and that cancel backs out clean.
//
//   RB_EMAIL=… RB_PASSWORD=… node tools/sims/live-route-wheel.mjs
//
// Credentials come from the environment. The run creates a trip in that real
// library and deletes it again. Needs `npm run dev` on :5199 and internet.
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

if (!process.env.RB_EMAIL || !process.env.RB_PASSWORD) {
  console.error('Set RB_EMAIL and RB_PASSWORD — this sim signs in to a real account.');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath, headless: false, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
// A real phone context: coarse pointer, touch events, 375px.
const context = await browser.newContext({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));

const valhalla = [];
page.on('request', (r) => { if (r.url().includes('valhalla')) valhalla.push(r.url()); });

await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="email"]', { timeout: 20000 });
await page.fill('input[type="email"]', process.env.RB_EMAIL);
await page.fill('input[type="password"]', process.env.RB_PASSWORD);
await page.click('button:has-text("Sign in")');
await page.waitForSelector('.trip-card', { timeout: 30000 });
await page.waitForTimeout(2500);
check(true, 'signed in on a phone-sized touch context against live Supabase');

await page.locator('.trip-card').first().click();
await page.waitForSelector('.modebar', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const mk = (id, name, lng, lat, kind) => ({ id, kind, name, lat, lng, mile: null, note: '' });
  window.__dispatch({
    type: 'create_trip',
    name: 'WHEEL LIVE',
    trip: {
      meta: {
        title: 'WHEEL LIVE', subtitle: '', summary: '', riders: 1, startDate: '2026-09-07',
        fuelRule: '', range: { comfort: 180, absolute: 200 }, roster: [],
        routePrefs: { style: 'touring', avoidTolls: false },
      },
      days: [{
        id: 'wl1', dow: 'Mon', date: '2026-09-07', title: 'Weehawken to Nyack', phase: 'rally',
        miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '',
        constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
        lodging: { status: 'none', name: '', where: '', note: '' },
        waypoints: [
          mk('w-start', '1500 Harbor Blvd, Weehawken', -74.0175, 40.768, 'start'),
          mk('w-end', 'Early Bird Coffee, Nyack', -73.9182, 41.0912, 'end'),
        ],
      }],
      reserveNow: [],
    },
  });
});
await page.waitForTimeout(1500);
await page.locator('.rchip').nth(1).click();
await page.waitForSelector('.wp-row', { timeout: 20000 });
await page.waitForTimeout(9000);

// On a phone the panel slides over the map — get back to bare map to touch the
// route at all. Tapping the PLAN seat again is the app's own way to do that.
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {});
await page.waitForTimeout(900);

const stops = () => page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('moto.trips.v1'));
  const rec = lib.trips.find((t) => t.id === lib.activeId) ?? lib.trips[0];
  return rec.trip.days[0].waypoints.map((w) => ({ name: w.name, kind: w.kind, lat: w.lat, lng: w.lng }));
});
const geom = () => page.evaluate(() => window.__map?.getSource('route-wl1')?._data?.geometry?.coordinates ?? []);

const before = await geom();
const east = before.filter((c) => c[0] > -73.99 && c[1] > 40.73 && c[1] < 40.88);
check(valhalla.length > 0 && before.length > 20, `live Valhalla returned the real road (${before.length} vertices, ${valhalla.length} requests)`);
check(east.length > 0, `the reported crossing into Manhattan is there to fix (${east.length} vertices east of the Hudson)`);

const pxOf = (ll) => page.evaluate((c) => {
  const p = window.__map.project(c);
  const r = window.__map.getCanvas().getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, ll);

// ---- tap the route: the wheel opens, nothing is edited ----------------------
const grab = east.reduce((a, b) => (b[0] > a[0] ? b : a), east[0]);
const tap = await pxOf(grab);
await page.touchscreen.tap(tap.x, tap.y);
await page.waitForTimeout(700);

const wheelUp = await page.locator('.route-wheel').count();
check(wheelUp === 1, `tapping the route opens the wheel (${wheelUp})`);
check((await stops()).length === 2, 'the tap alone edits nothing');
check(await page.locator('.modal.sheet, .modal').count() === 0, 'the tap does not throw a modal over the map instead');

const parts = await page.evaluate(() => {
  const w = document.querySelector('.route-wheel');
  const box = (sel) => { const e = w.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; };
  return { grip: box('.rw-grip'), confirm: box('.rw-act.confirm'), cancel: box('.rw-act.cancel'), info: box('.rw-act.info'), hint: document.querySelector('.map-hint')?.textContent };
});
check(!!parts.grip && !!parts.confirm && !!parts.cancel && !!parts.info, 'the wheel carries a grip, confirm, cancel and leg details');
check(parts.confirm.w >= 44 && parts.confirm.h >= 44 && parts.cancel.w >= 44 && parts.info.w >= 44,
  `every action is a 44pt target (confirm ${parts.confirm.w}×${parts.confirm.h}, cancel ${parts.cancel.w}, info ${parts.info.w})`);
check(parts.grip.w >= 44, `the grip is a 44pt target (${parts.grip.w}px)`);
const onScreen = [parts.grip, parts.confirm, parts.cancel, parts.info]
  .every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= 375 && b.y + b.h <= 812);
check(onScreen, 'the whole wheel fits inside a 375px screen');
check(/Drag onto the road/.test(parts.hint ?? ''), `it says what to do (${parts.hint})`);
await page.screenshot({ path: SHOT('live-wheel-open') });

// ---- cancel backs out clean ------------------------------------------------
await page.touchscreen.tap(parts.cancel.x + parts.cancel.w / 2, parts.cancel.y + parts.cancel.h / 2);
await page.waitForTimeout(500);
check(await page.locator('.route-wheel').count() === 0, 'cancel closes the wheel');
check((await stops()).length === 2, 'cancel leaves the day alone');
check(await page.evaluate(() => window.__map.getSource('route-drag')?._data?.geometry?.coordinates?.length) === 0,
  'cancel clears the proposal line');

// ---- reopen, drag the grip, confirm ----------------------------------------
await page.touchscreen.tap(tap.x, tap.y);
await page.waitForTimeout(700);
const grip = await page.evaluate(() => { const r = document.querySelector('.rw-grip').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
const drop = await pxOf([-74.025, grab[1]]);

// A real finger: touchstart, a few touchmoves, touchend.
await page.evaluate(async ([from, to]) => {
  const el = document.elementFromPoint(from.x, from.y);
  const touch = (type, x, y) => {
    const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
  };
  touch('touchstart', from.x, from.y);
  for (let i = 1; i <= 10; i++) {
    await new Promise((r) => setTimeout(r, 30));
    touch('touchmove', from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  }
  touch('touchend', to.x, to.y);
}, [grip, drop]);
await page.waitForTimeout(600);

const pulled = await page.evaluate(() => {
  const h = document.querySelector('.map-hint');
  const r = h.getBoundingClientRect();
  return {
    band: window.__map.getSource('route-drag')?._data?.geometry?.coordinates?.length ?? 0,
    hint: h.textContent,
    // The first live run hung this readout off the marker and it clipped at
    // the screen edge. It lives in the map's own hint region now.
    clipped: r.left < 0 || r.right > window.innerWidth || h.scrollWidth > h.clientWidth + 1,
  };
});
check(pulled.band === 3, `dragging the grip rubber-bands the leg (${pulled.band} points)`);
check(/off route/.test(pulled.hint ?? ''), `the wheel reports how far it has been pulled (${pulled.hint?.trim()})`);
check(!pulled.clipped, 'the readout is fully on screen, not clipped at the edge');
check((await stops()).length === 2, 'still nothing committed until confirm is pressed');
await page.screenshot({ path: SHOT('live-wheel-pulled') });

const conf = await page.evaluate(() => { const r = document.querySelector('.rw-act.confirm').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
await page.touchscreen.tap(conf.x, conf.y);
await page.waitForTimeout(13000);

const after = await stops();
check(after.length === 3 && after[1].kind === 'via', `confirm places the stop (${after.map((s) => s.name).join(' → ')})`);
check(after[0].name.includes('Weehawken') && after[2].name.includes('Nyack'), 'endpoints untouched');
check(await page.locator('.route-wheel').count() === 0, 'the wheel closes after confirming');

const afterGeom = await geom();
const stillEast = afterGeom.filter((c) => c[0] > -73.99 && c[1] > 40.73 && c[1] < 40.88);
check(stillEast.length === 0, `THE FIX, from a phone: the live re-route no longer enters Manhattan (${stillEast.length}, was ${east.length})`);
await page.screenshot({ path: SHOT('live-wheel-after') });

await page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('moto.trips.v1'));
  for (const rec of lib.trips.filter((t) => t.trip?.meta?.title === 'WHEEL LIVE')) {
    window.__dispatch({ type: 'delete_trip', id: rec.id });
  }
});
await page.waitForTimeout(2500);
check(!(await page.evaluate(() => JSON.parse(localStorage.getItem('moto.trips.v1')).trips.some((t) => t.trip?.meta?.title === 'WHEEL LIVE'))),
  'the test trip was removed from the real library afterwards');

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
