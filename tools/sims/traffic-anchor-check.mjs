// The traffic overlay: Valhalla owns the ROAD, Google owns the CLOCK.
//
// Ride Mode's 10-minute anchor fetches a traffic-aware total over the remaining
// stops and applies ONLY the time — the route line is never touched. From #68
// (Sep 7, "Make Valhalla authoritative") until trafficEta() existed, the anchor
// called routeFrom, which is Valhalla-first and carries no `traffic` flag, so
// the overlay was silently dark whenever Valhalla was healthy: the ETA on the
// bar was the static plan the whole time. This sim asserts the settled contract
// on the built-or-dev app:
//   · while Valhalla answers every routing call, Google is STILL asked for the
//     clock, tagged `purpose: 'eta'`
//   · the day-end ETA on the bar moves by the traffic delta Google reports
//   · the route line stays Valhalla's geometry — Google's road is never adopted
//   · an unconfigured Google (501) leaves the static ETA standing, no error
//
//   npm run dev    # :5199
//   node tools/sims/traffic-anchor-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { seedRideAck } from './fixtures/ride-ack.mjs';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
const R = 3958.8;
const hav = (a, b) => {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180, dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180, la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

// polyline6 (lat-first, 1e6) — the Valhalla shape format
const enc6 = (pts) => {
  let out = '', plat = 0, plng = 0;
  const enc = (v) => {
    let s = '';
    v = v < 0 ? ~(v << 1) : (v << 1);
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lng, lat] of pts) {
    const ilat = Math.round(lat * 1e6), ilng = Math.round(lng * 1e6);
    out += enc(ilat - plat) + enc(ilng - plng);
    plat = ilat; plng = ilng;
  }
  return out;
};

// Valhalla: a bent road at 50 mph. Its shape is deliberately NOT a straight
// line so the "geometry never adopted" check has something to measure.
const BEND = 0.018;
let valhallaCalls = 0;
let lastValhallaShape = null;
function buildValhalla(reqBody) {
  valhallaCalls++;
  const locs = reqBody.locations.map((l) => [l.lon, l.lat]);
  const legs = [];
  let totalMi = 0, totalSec = 0;
  const all = [];
  for (let i = 0; i < locs.length - 1; i++) {
    const a = locs[i], b = locs[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const off = (p) => [p[0] + nx * BEND, p[1] + ny * BEND];
    const pts = [a, off(lerp(a, b, 0.4)), off(lerp(a, b, 0.7)), b];
    all.push(...(i ? pts.slice(1) : pts));
    const mi = pts.slice(1).reduce((s, p, k) => s + hav(pts[k], p), 0);
    const sec = (mi / 50) * 3600;
    totalMi += mi; totalSec += sec;
    legs.push({
      shape: enc6(pts), summary: { length: mi, time: sec },
      maneuvers: [
        { type: i === 0 ? 1 : 8, instruction: 'Ride north on Spur Road.', street_names: ['Spur Road'], length: mi * 0.6, time: sec * 0.6, begin_shape_index: 0 },
        { type: 15, instruction: 'Turn left onto Granite Pass Road.', street_names: ['Granite Pass Road'], length: mi * 0.4, time: sec * 0.4, begin_shape_index: 2 },
        { type: 4, instruction: 'You have arrived at your destination.', length: 0, time: 0, begin_shape_index: 3 },
      ],
    });
  }
  lastValhallaShape = all;
  return { trip: { legs, summary: { length: totalMi, time: totalSec }, status: 0, units: 'miles' } };
}

// Google: a STRAIGHT road (so it is distinguishable from Valhalla's bend) that
// takes TRAFFIC_EXTRA_MIN longer than free flow — a jam on the pass.
const TRAFFIC_EXTRA_MIN = 37;
let googleEtaCalls = 0, googleRoutingCalls = 0, googleMode = 'ok'; // ok | 501
let lastGoogleBody = null;
function buildGoogle(body) {
  const pts = [[body.origin.lng, body.origin.lat], ...body.waypoints.map((w) => [w.lng, w.lat])];
  const geometry = [];
  let mi = 0;
  const legs = pts.slice(1).map((b, i) => {
    const a = pts[i];
    const seg = [a]; for (let k = 1; k <= 6; k++) seg.push(lerp(a, b, k / 7)); seg.push(b);
    geometry.push(...(i ? seg.slice(1) : seg));
    const d = hav(a, b); mi += d;
    return { distanceMeters: d * 1609.34, durationSeconds: (d / 50) * 3600, steps: [{ lat: a[1], lng: a[0], distanceMeters: d * 1609.34, staticDurationSeconds: (d / 50) * 3600, instruction: 'Continue', maneuver: 'STRAIGHT', geometry: seg }] };
  });
  const freeFlow = (mi / 50) * 3600;
  return { geometry, distanceMeters: mi * 1609.34, durationSeconds: freeFlow + TRAFFIC_EXTRA_MIN * 60, legs };
}

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function session(label) {
  console.log(`\n── ${label} ──`);
  const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.includes('/.netlify/functions/google-route')) {
      const body = r.request().postDataJSON();
      if (body?.purpose === 'eta') googleEtaCalls++; else googleRoutingCalls++;
      lastGoogleBody = body;
      if (googleMode === '501') return r.fulfill({ status: 501, json: { error: 'GOOGLE_MAPS_API_KEY not configured' } });
      return r.fulfill({ json: buildGoogle(body) });
    }
    if (u.includes('localhost:5199')) return r.continue();
    if (u.includes('valhalla1.openstreetmap.de/route')) return r.fulfill({ json: buildValhalla(r.request().postDataJSON()) });
    if (u.includes('router.project-osrm.org')) {
      // lane/ref enrichment only — never a routing fallback in this sim
      return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
    }
    return r.abort();
  });
  await page.addInitScript(() => {
    const stub = { watchPosition: (cb) => { window.__geoCb = cb; return 1; }, clearWatch: () => {}, getCurrentPosition: (cb) => { if (window.__lastFix) cb(window.__lastFix); } };
    Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
    window.__feed = (lat, lng, heading, mps) => {
      window.__lastFix = { coords: { latitude: lat, longitude: lng, accuracy: 5, speed: mps, heading }, timestamp: Date.now() };
      window.__geoCb?.(window.__lastFix);
    };
  });
  await seedRideAck(page); // Ride Mode's safety gate is answered once per device
  await page.goto('http://localhost:5199/');
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.trip-card', { timeout: 15000 });
  { const tb = page.locator('.hm-tripsbtn'); if (await tb.isVisible().catch(() => false)) { await tb.click(); await page.waitForTimeout(400); } } // the desktop home keeps the library in a closed drawer
  await page.click('.trip-card');
  await page.waitForSelector('.modebar', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const mk = (id, name, lat, lng) => ({ id, kind: 'via', name, lat, lng, mile: null, note: '' });
    window.__dispatch({
      type: 'create_trip', name: 'TRAFFIC TEST',
      trip: {
        meta: { title: 'TRAFFIC TEST', subtitle: '', summary: '', riders: 1, startDate: '2026-08-12', fuelRule: '', range: 200, roster: [] },
        days: [{
          id: 't1', dow: 'Wed', date: '2026-08-12', title: 'Traffic day', phase: 'rally',
          miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '', constraints: [], gates: [],
          meals: [], photos: [], modules: [], ops: [], lodging: { status: 'none', name: '', where: '', note: '' },
          waypoints: [mk('ts', 'Basecamp', 44.0, -108.0), mk('ta', 'Granite Diner', 44.06, -107.95), mk('tb', 'End Lodge', 44.10, -107.88)],
        }],
      },
    });
  });
  await page.waitForTimeout(1000);
  await page.locator('.modebar button', { hasText: /ride/i }).click();
  await page.waitForSelector('.ride-bar', { timeout: 15000 });
  await page.waitForTimeout(800);
  return page;
}

// minutes-of-day from a "h:mm AM" clock string
const clockMin = (s) => {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(s || '');
  if (!m) return null;
  let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
};
const readEta = (page) => page.evaluate(() => document.querySelector('.rb-day')?.textContent ?? '');
const routeLine = (page) => page.evaluate(() => {
  const m = window.__rideMap;
  const src = m?.getSource?.('ride-route');
  const d = src?._data;
  const f = d?.features?.[0] ?? d;
  return f?.geometry?.coordinates ?? null;
});

// The day-end figure only renders once nav has a fix, and the anchor fires on
// the first good fix — so the "static" reading comes from a session where
// Google answers 501, and the "traffic" reading from one where it answers.
// Same route, same mocks, minutes apart on the clock.
let staticEta = null;

// ---- 1. Google not configured: static ETA, one probe, no error ----
{
  googleMode = '501';
  const page = await session('Google unconfigured (501)');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const t of [0.02, 0.05, 0.08]) {
    const [lng, lat] = lerp([-108.0, 44.0], [-107.95, 44.06], t);
    await page.evaluate(([a, b]) => window.__feed(a, b, 40, 18), [lat, lng]);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(700);
  staticEta = await readEta(page);
  check(googleEtaCalls === 1, `one probe, then backoff (${googleEtaCalls} call(s))`);
  check(clockMin(staticEta) != null, `static ETA renders ("${staticEta.trim()}")`);
  check(errors.length === 0, 'no page errors without a Google key');
  await page.close();
}

// ---- 2. Google configured: the clock moves, the road does not ----
{
  googleMode = 'ok'; googleEtaCalls = 0; googleRoutingCalls = 0; valhallaCalls = 0;
  const page = await session('Google configured');
  const etaBefore = staticEta;
  const feed = async (t) => {
    const [lng, lat] = lerp([-108.0, 44.0], [-107.95, 44.06], t);
    await page.evaluate(([a, b]) => window.__feed(a, b, 40, 18), [lat, lng]);
    await page.waitForTimeout(400);
  };
  await feed(0.02); await feed(0.05); await feed(0.08);
  await page.waitForTimeout(900);
  check(valhallaCalls >= 1, `Valhalla answered the routing (${valhallaCalls} calls)`);
  check(googleEtaCalls >= 1, `Google was still asked for the clock (${googleEtaCalls} eta call(s)) — the regression #68 introduced`);
  check(googleRoutingCalls === 0, `…and never for a road (${googleRoutingCalls} routing calls)`);
  check(lastGoogleBody?.waypoints?.length === 2 && Number.isFinite(lastGoogleBody?.origin?.heading),
    `the eta request carries the remaining stops and the bike's heading (${lastGoogleBody?.waypoints?.length} stops, heading ${lastGoogleBody?.origin?.heading})`);
  const etaAfter = await readEta(page);
  const a = clockMin(etaBefore), b = clockMin(etaAfter);
  const delta = a != null && b != null ? b - a : null;
  check(delta != null && Math.abs(delta - TRAFFIC_EXTRA_MIN) <= 4,
    `day-end ETA moved by the traffic delta ("${etaBefore.trim()}" → "${etaAfter.trim()}", Δ ${delta} min, expected ~${TRAFFIC_EXTRA_MIN})`);
  // the drawn line is Valhalla's bent road, not Google's straight one
  const line = await routeLine(page);
  const bentness = (pts) => {
    if (!pts || pts.length < 3) return 0;
    const a0 = pts[0], b0 = pts[pts.length - 1];
    return Math.max(...pts.map((p) => {
      const t = ((p[0] - a0[0]) * (b0[0] - a0[0]) + (p[1] - a0[1]) * (b0[1] - a0[1])) / ((b0[0] - a0[0]) ** 2 + (b0[1] - a0[1]) ** 2 || 1);
      const q = lerp(a0, b0, Math.max(0, Math.min(1, t)));
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    }));
  };
  const bend = bentness(line);
  check(line && bend > BEND * 0.5, `route line is still Valhalla's road (max deviation from chord ${bend.toFixed(4)}°, Valhalla bends ${BEND})`);
  await page.screenshot({ path: SHOT('traffic-anchor') });
  await page.close();
}

await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
