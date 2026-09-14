// The gate in front of Ride Mode (Sep 14, 2026). Four facts, full screen, once
// — and gated on the MOUNT, so nothing behind it starts until it is answered.
//
//   npm run dev    # :5199
//   node tools/sims/ride-safety-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';

let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium';
const PORT = process.env.RB_PORT ?? '5199';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

const TRIP = {
  meta: { title: 'BEARTOOTH', subtitle: '', summary: '', riders: 1, startDate: '2026-08-12', fuelRule: '', range: 200, roster: [] },
  days: [{
    id: 'd1', dow: 'Wed', date: '2026-08-12', title: 'Red Lodge day', phase: 'outbound',
    miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '',
    constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
    lodging: { status: 'none', name: '', where: '', note: '' },
    waypoints: [
      { id: 'w1', kind: 'start', name: 'Red Lodge', lat: 45.186, lng: -109.247, mile: null, note: '' },
      { id: 'w2', kind: 'end', name: 'Cooke City', lat: 45.021, lng: -109.932, mile: null, note: '' },
    ],
  }],
};

async function open(ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message); });
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes(`localhost:${PORT}`)) return r.continue();
    return r.abort();
  });
  // a GPS watch is the thing that must NOT start behind the gate
  await page.addInitScript(() => {
    window.__geoWatches = 0;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (ok) => ok({ coords: { latitude: 45.186, longitude: -109.247, accuracy: 5, speed: 0, heading: 0 }, timestamp: Date.now() }),
        watchPosition: () => { window.__geoWatches++; return 1; },
        clearWatch: () => {},
      },
    });
  });
  await page.goto(`http://localhost:${PORT}/`);
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.home-map', { timeout: 20000 });
  await page.evaluate((trip) => window.__dispatch({ type: 'create_trip', name: trip.meta.title, trip }), TRIP);
  await page.waitForTimeout(800);
  // create_trip lands the record in the library but stays on the front door, so
  // the sim walks in the way a rider does. On a desktop the library is a drawer.
  const tripsBtn = page.locator('.hm-tripsbtn');
  if (await tripsBtn.isVisible().catch(() => false)) { await tripsBtn.click(); await page.waitForTimeout(300); }
  await page.locator('.trip-card').first().click();
  await page.waitForSelector('.ride-seat', { timeout: 15000 });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}

const startRide = async (page) => {
  await page.locator('.ride-seat').first().click();
  await page.waitForTimeout(600);
};

async function run(width, label) {
  console.log(`\n── ${label} (${width}px) ──`);
  const phone = width < 820;
  const { ctx, page, errors } = await open({ viewport: { width, height: 820 }, hasTouch: phone, isMobile: phone });

  const watchesBefore = await page.evaluate(() => window.__geoWatches);
  await startRide(page);
  const g = await page.evaluate(() => {
    const el = document.querySelector('.ride-safety');
    if (!el) return null;
    const btn = (s) => { const b = document.querySelector(s); return b ? Math.round(b.getBoundingClientRect().height) : 0; };
    return {
      title: document.querySelector('#rs-title')?.textContent,
      rules: document.querySelectorAll('.rs-rules li').length,
      heads: [...document.querySelectorAll('.rs-rules b')].map((b) => b.textContent),
      go: btn('.rs-go'), not: btn('.rs-not'),
      legal: document.querySelectorAll('.rs-legal button').length,
      rideMounted: !!document.querySelector('.ride-mode'),
      watches: window.__geoWatches,
      sideways: document.documentElement.scrollWidth > innerWidth,
      clipped: el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'auto',
      ack: localStorage.getItem('moto.rideSafety.v1'),
    };
  });
  check(!!g, 'the gate stands in front of Ride Mode');
  if (!g) { await ctx.close(); return; }
  check(g.title === 'Before you ride', `it says what it is (“${g.title}”)`);
  check(g.rules === 4, `four rules (${g.rules})`);
  check(/Mount the phone/i.test(g.heads[0]) && /Roadbook can be wrong/i.test(g.heads[3]),
    `the mount and the fallibility are both stated (${g.heads.length} heads)`);
  check(!g.rideMounted, 'Ride Mode has NOT mounted behind it');
  check(g.watches === watchesBefore, `no NEW GPS watch behind the gate (${watchesBefore} before, ${g.watches} after — Home keeps one open for the rider dot)`);
  check(g.go >= 52 && g.not >= 44, `glove-sized actions (accept ${g.go}px, not-now ${g.not}px)`);
  check(g.legal === 2, `Terms and Privacy are reachable from here (${g.legal} links)`);
  check(!g.sideways && !g.clipped, 'nothing scrolls sideways and nothing is cut off');
  check(g.ack === null, 'nothing is recorded until the rider accepts');
  if (phone) await page.screenshot({ path: SHOT('ride-safety'), fullPage: false });

  // Not now backs out and records nothing
  await page.locator('.rs-not').click();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    gate: !!document.querySelector('.ride-safety'), ride: !!document.querySelector('.ride-mode'),
    ack: localStorage.getItem('moto.rideSafety.v1'), watches: window.__geoWatches,
  }));
  check(!after.gate && !after.ride, 'Not now closes both the gate and the ride');
  check(after.ack === null && after.watches === watchesBefore, `declining records nothing and starts nothing (${after.watches} watches)`);

  // accept → Ride Mode mounts, and the tick is stamped with a version and a time
  await startRide(page);
  await page.locator('.rs-go').click();
  await page.waitForTimeout(1200);
  const on = await page.evaluate(() => ({
    gate: !!document.querySelector('.ride-safety'), ride: !!document.querySelector('.ride-mode'),
    ack: JSON.parse(localStorage.getItem('moto.rideSafety.v1') || 'null'),
  }));
  check(!on.gate && on.ride, 'accepting mounts Ride Mode');
  check(on.ack?.v === 1 && !Number.isNaN(Date.parse(on.ack?.at ?? '')),
    `the acknowledgement carries its version and its moment (${JSON.stringify(on.ack)})`);

  // a second ride does not ask again
  await page.evaluate(() => document.querySelector('.ride-topbar .ride-x, .ride-x')?.click());
  await page.waitForTimeout(600);
  await startRide(page);
  const again = await page.evaluate(() => ({ gate: !!document.querySelector('.ride-safety'), ride: !!document.querySelector('.ride-mode') }));
  check(!again.gate && again.ride, 'a rider is asked once, not every ride');

  // a version bump asks again — the whole point of storing the version
  await page.evaluate(() => localStorage.setItem('moto.rideSafety.v1', JSON.stringify({ v: 0, at: '2020-01-01T00:00:00Z' })));
  await page.reload();
  const guest2 = page.locator('.land-skip');
  if (await guest2.isVisible().catch(() => false)) await guest2.click();
  await page.waitForTimeout(1500);
  await startRide(page);
  const bumped = await page.evaluate(() => !!document.querySelector('.ride-safety'));
  check(bumped, 'a stale acknowledgement gates again');

  check(errors.length === 0, `no page errors (${errors.length})`);
  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
