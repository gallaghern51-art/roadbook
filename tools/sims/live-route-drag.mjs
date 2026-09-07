// LIVE route-drag check — the ONLY sim in here with no mocked network.
//
// Every other sim fulfils its own OSRM/Valhalla/Places responses, which is what
// makes them deterministic. This one deliberately does not: it signs in to a
// real account against live Supabase and lets the app talk to the real Valhalla
// endpoint over the real road network, because the bug it covers is a property
// of that network. It reproduces the reported Weehawken -> Nyack routing (which
// crosses into Manhattan and back over the George Washington Bridge) and then
// fixes it by dragging the route line into New Jersey.
//
//   RB_EMAIL=… RB_PASSWORD=… node tools/sims/live-route-drag.mjs
//
// Credentials come from the environment and are never written down here. The
// run creates a trip in that real library and DELETES it again at the end.
// Needs `npm run dev` on :5199 and working internet; it is not deterministic
// and does not belong in a pre-push loop — run it when the routing behavior
// itself is what you need to be sure about.
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
const R = 3958.8;
const hav = (a, b) => {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180, dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180, la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

if (!process.env.RB_EMAIL || !process.env.RB_PASSWORD) {
  console.error('Set RB_EMAIL and RB_PASSWORD — this sim signs in to a real account.');
  process.exit(2);
}
const browser = await chromium.launch({
  executablePath,
  headless: false, // watch it happen; this one is about believing the result
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));

// Watch the REAL routing traffic — this is the evidence that nothing is mocked.
const valhallaBodies = [];
page.on('request', (r) => {
  if (r.url().includes('valhalla')) {
    try { valhallaBodies.push(JSON.parse(r.postData())); } catch { /* not json */ }
  }
});

await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });

// ---- real sign-in -----------------------------------------------------------
await page.waitForSelector('input[type="email"]', { timeout: 20000 });
await page.fill('input[type="email"]', process.env.RB_EMAIL);
await page.fill('input[type="password"]', process.env.RB_PASSWORD);
await page.click('button:has-text("Sign in")');
await page.waitForSelector('.trip-card, .home', { timeout: 30000 });
await page.waitForTimeout(2500);
const signedIn = await page.evaluate(() => !document.querySelector('input[type="password"]'));
check(signedIn, 'signed in to the real account against live Supabase');
const cards = await page.locator('.trip-card').count();
console.log(`   (the account's library loaded: ${cards} trips)`);

// ---- the reported trip, built through the app -------------------------------
// Enter the workspace first (create_trip switches the active trip; it does not
// move the app off Home on its own).
await page.locator('.trip-card').first().click();
await page.waitForSelector('.modebar', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const mk = (id, name, lng, lat, kind) => ({ id, kind, name, lat, lng, mile: null, note: '' });
  window.__dispatch({
    type: 'create_trip',
    name: 'WEEHAWKEN LIVE',
    trip: {
      meta: {
        title: 'WEEHAWKEN LIVE', subtitle: '', summary: '', riders: 1,
        startDate: '2026-09-07', fuelRule: '', range: { comfort: 180, absolute: 200 }, roster: [],
        routePrefs: { style: 'touring', avoidTolls: false },
      },
      days: [{
        id: 'live1', dow: 'Mon', date: '2026-09-07', title: 'Weehawken to Nyack', phase: 'rally',
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
// Real Valhalla over the public endpoint — give it room.
await page.waitForTimeout(9000);

const live = valhallaBodies.length > 0;
check(live, `routing went to the LIVE Valhalla endpoint (${valhallaBodies.length} request(s), costing=${valhallaBodies[0]?.costing}, use_tolls=${valhallaBodies[0]?.costing_options?.motorcycle?.use_tolls})`);

const readGeom = () => page.evaluate(() => window.__map?.getSource('route-live1')?._data?.geometry?.coordinates ?? []);
const before = await readGeom();
check(before.length > 20, `the real road geometry came back (${before.length} vertices)`);

// Did it cross into Manhattan? The Hudson is at about -74.01 on this stretch;
// anything east of -73.99 between the two stops is the New York side.
const intoManhattan = before.filter((c) => c[0] > -73.99 && c[1] > 40.73 && c[1] < 40.88);
check(intoManhattan.length > 0,
  `THE REPORTED BUG REPRODUCES: the live route crosses into Manhattan (${intoManhattan.length} vertices east of the Hudson)`);
const milesBefore = await page.locator('.stat .v, .day-stats').first().innerText().catch(() => '?');
await page.screenshot({ path: SHOT('live-1-before') });

// ---- drag the line back into New Jersey -------------------------------------
// Grab the route where it is deepest into Manhattan.
const grab = intoManhattan.reduce((a, b) => (b[0] > a[0] ? b : a), intoManhattan[0]);
// Drop it on the west bank at the same latitude — the Palisades corridor.
const drop = [-73.99 - 0.035, grab[1]];

const pxOf = (ll) => page.evaluate((c) => {
  const p = window.__map.project(c);
  const r = window.__map.getCanvas().getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, ll);
const from = await pxOf(grab);
const to = await pxOf(drop);
console.log(`   grabbing ${grab.map((n) => n.toFixed(4))} -> dropping ${drop.map((n) => n.toFixed(4))} (${Math.round(Math.hypot(to.x - from.x, to.y - from.y))}px)`);

await page.mouse.move(from.x, from.y);
await page.waitForTimeout(300);
check(await page.evaluate(() => window.__map.getCanvas().style.cursor) === 'grab',
  'the live route offers a grab cursor');
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 20 });
await page.waitForTimeout(200);
check(await page.evaluate(() => window.__map.getSource('route-drag')?._data?.geometry?.coordinates?.length) === 3,
  'the rubber band tracks the cursor over the live map');
await page.screenshot({ path: SHOT('live-2-dragging') });
await page.mouse.up();

// Real re-route over the public endpoint.
await page.waitForTimeout(12000);

const stops = await page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('moto.trips.v1'));
  const rec = lib.trips.find((t) => t.id === lib.activeId) ?? lib.trips[0];
  return rec.trip.days[0].waypoints.map((w) => ({ name: w.name, kind: w.kind, lat: w.lat, lng: w.lng }));
});
check(stops.length === 3, `the drop added one stop (${stops.map((s) => s.name).join(' → ')})`);
check(stops[1]?.kind === 'via' && stops[0]?.name.includes('Weehawken') && stops[2]?.name.includes('Nyack'),
  'it went into the middle of the day, endpoints untouched');

const after = await readGeom();
const stillManhattan = after.filter((c) => c[0] > -73.99 && c[1] > 40.73 && c[1] < 40.88);
check(after.length > 20 && valhallaBodies.length > 1,
  `the day was re-routed live after the drop (${valhallaBodies.length} Valhalla requests total)`);
check(stillManhattan.length === 0,
  `THE FIX: the live re-route no longer enters Manhattan (${stillManhattan.length} vertices east of the Hudson, was ${intoManhattan.length})`);

const nearest = after.reduce((best, c) => Math.min(best, hav(c, [stops[1].lng, stops[1].lat])), Infinity);
check(nearest < 0.4, `the real road now passes through the dropped point (${nearest.toFixed(2)} mi)`);

const rows = await page.locator('.wp-row').allTextContents();
console.log('   day panel order:', rows.map((r) => r.replace(/\s+/g, ' ').trim().slice(0, 42)));
await page.screenshot({ path: SHOT('live-3-after') });

// This ran against the owner's real library, which backs up to their account —
// take the test trip back out.
await page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('moto.trips.v1'));
  // EVERY match, not the first — an earlier aborted run leaves one behind, and
  // a leftover here syncs to the owner's real account.
  for (const rec of lib.trips.filter((t) => t.trip?.meta?.title === 'WEEHAWKEN LIVE')) {
    window.__dispatch({ type: 'delete_trip', id: rec.id });
  }
});
await page.waitForTimeout(2500);
const left = await page.evaluate(() => JSON.parse(localStorage.getItem('moto.trips.v1')).trips.some((t) => t.trip?.meta?.title === 'WEEHAWKEN LIVE'));
check(!left, 'the test trip was removed from the real library afterwards');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('miles before:', milesBefore.replace(/\n/g, ' ').slice(0, 60));
await page.waitForTimeout(2000);
await browser.close();
process.exit(fail ? 1 : 0);
