// The traffic time on the PLANNING screen (owner, Sep 20 2026: "show me the
// traffic time on the planning screen too").
//
// The day panel's hours are Valhalla's: honest about the road, free-flowing by
// construction. This line says what the day costs in the traffic predicted for
// the departure it is planned from — measured eastern Long Island → NYC, the
// same 104 miles answer 117 min at 3 AM Wednesday and 175 min at 9 AM Tuesday.
//
//   npm run dev    # :5199 (RB_PORT overrides)
//   node tools/sims/day-traffic-check.mjs

import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';

const PORT = process.env.RB_PORT ?? '5199';
const BASE = `http://localhost:${PORT}`;
let pass = 0; let fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (ok) pass++; else fail++; };

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const enc6 = (pts) => {
  let out = ''; let plat = 0; let plng = 0;
  const enc = (v0) => { let s = ''; let v = v0 < 0 ? ~(v0 << 1) : (v0 << 1); while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lng, lat] of pts) { const a = Math.round(lat * 1e6); const b = Math.round(lng * 1e6); out += enc(a - plat) + enc(b - plng); plat = a; plng = b; }
  return out;
};
// the plan: 104 miles, 129 minutes free-flowing — Valhalla's real answer
function valhalla(body) {
  const locs = body.locations.map((l) => [l.lon, l.lat]);
  const legs = [];
  for (let i = 0; i < locs.length - 1; i++) {
    const a = locs[i]; const b = locs[i + 1];
    legs.push({
      shape: enc6([a, lerp(a, b, 0.5), b]),
      summary: { length: 104.5 / (locs.length - 1), time: (129 * 60) / (locs.length - 1) },
      maneuvers: [
        { type: 1, instruction: 'Ride.', street_names: ['NY 27'], length: 104.5, time: 129 * 60, begin_shape_index: 0 },
        { type: 4, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: 2 },
      ],
    });
  }
  return { trip: { legs, summary: { length: 104.5, time: 129 * 60, has_toll: false }, status: 0, units: 'miles' } };
}

const ymd = (d) => d.toISOString().slice(0, 10);
const IN_TWO_DAYS = ymd(new Date(Date.now() + 2 * 86400_000));
const YESTERDAY = ymd(new Date(Date.now() - 86400_000));

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function run(width, label, { keyed = true } = {}) {
  console.log(`\n── ${label} (${width}px) ──`);
  const phone = width < 820;
  const ctx = await browser.newContext({ viewport: { width, height: 812 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message); });
  const gCalls = [];

  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes('/.netlify/functions/google-route')) {
      gCalls.push(r.request().postDataJSON());
      if (!keyed) return r.fulfill({ status: 501, json: { error: 'GOOGLE_MAPS_API_KEY not configured' } });
      // 175 min: the Tuesday-9am answer for this corridor
      return r.fulfill({ json: { geometry: [[-72.18, 40.96], [-74.0, 40.71]], distanceMeters: 168_000, durationSeconds: 175 * 60 } });
    }
    if (u.includes('/.netlify/functions/')) return r.fulfill({ status: 404, json: {} });
    if (u.includes('valhalla1.openstreetmap.de/route')) return r.fulfill({ json: valhalla(r.request().postDataJSON()) });
    if (u.includes('router.project-osrm.org')) return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
    if (u.startsWith(BASE)) return r.continue();
    return r.abort();
  });

  await page.goto(`${BASE}/`);
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.home-map', { timeout: 20000 });

  // a two-day trip: one ahead of the rider, one already ridden
  await page.evaluate(({ soon, past }) => {
    const wp = (id, name, lat, lng, kind) => ({ id, kind, name, lat, lng, mile: null, note: '' });
    const day = (id, date, dow, title) => ({
      id, dow, date, title, phase: 'outbound', miles: 0, hours: 0, depart: '9:00 AM', arrive: '',
      anchor: false, summary: '', constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
      lodging: { status: 'none', name: '', where: '', note: '' },
      waypoints: [wp(`${id}a`, 'Riverhead', 40.9634, -72.1848, 'start'), wp(`${id}b`, 'New York', 40.7128, -74.0060, 'end')],
    });
    window.__dispatch({
      type: 'create_trip',
      name: 'LI RUN',
      trip: {
        // cascadeDates re-pins every day from meta.startDate, so the dates
        // below are what the trip will actually carry: day 1 yesterday
        // (already ridden), day 2 the day after tomorrow.
        meta: { title: 'LI RUN', subtitle: '', summary: '', riders: 1, startDate: past, range: 200, roster: [], utcOffset: -4, routePrefs: { style: 'touring', avoidTolls: false } },
        days: [day('dpast', past, 'Sat', 'The way out'), day('dsoon', soon, 'Mon', 'The way back')],
      },
    });
  }, { soon: IN_TWO_DAYS, past: YESTERDAY });
  await page.waitForTimeout(1200);
  // the library lives in a closed drawer on a desktop home, and the seed
  // template sits beside the new trip — open OURS by name, not by position
  if (!(await page.locator('.modebar').isVisible().catch(() => false))) {
    const tb = page.locator('.hm-tripsbtn');
    if (await tb.isVisible().catch(() => false)) { await tb.click(); await page.waitForTimeout(400); }
    await page.locator('.trip-card', { hasText: 'LI RUN' }).first().click();
  }
  await page.waitForSelector('.modebar', { timeout: 15000 });
  // the trip's real dates, after cascadeDates has had its say
  const dates = await page.evaluate(() => {
    const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
    return l.trips.find((r) => r.id === l.activeId).trip.days.map((d) => d.date);
  });
  check(dates.length === 2, `the test trip is on screen (${dates.join(', ')})`);

  // pick a day the way a rider does — the ribbon chip, which lands in PLAN
  // with the panel open
  // The ribbon leads with a Trip chip, so a day is picked by its DATE, never
  // by its index in the strip.
  const openDay = async (i) => {
    await page.waitForSelector('.rchip', { timeout: 10000 });
    const [, mo, d] = dates[i].split('-');
    await page.locator('.rchip', { hasText: `${Number(mo)}/${Number(d)}` }).first().click();
    await page.waitForTimeout(500);
    if (!(await page.locator('.stat-row').isVisible().catch(() => false))) {
      const tab = page.locator('.panel-tab');
      if (await tab.isVisible().catch(() => false)) await tab.click();
    }
    await page.waitForSelector('.stat-row', { timeout: 10000 });
  };

  // ---- the day still ahead ----
  await openDay(1);

  if (!keyed) {
    await page.waitForTimeout(2500);
    check(await page.locator('.day-traffic').count() === 0, 'with no Google key the panel says nothing at all');
    check(errors.length === 0, `no page errors (${errors.length})`);
    await ctx.close();
    return;
  }

  const shown = await page.waitForSelector('.day-traffic:not(.asking)', { timeout: 20000 }).then(() => true).catch(() => false);
  check(shown, 'a day still ahead shows what it will cost in traffic');
  const line = await page.evaluate(() => {
    const el = document.querySelector('.day-traffic');
    const row = document.querySelector('.stat-row');
    return {
      text: el?.innerText.replace(/\s+/g, ' ').trim(),
      heavy: el?.classList.contains('heavy'),
      belowStats: el && row ? el.getBoundingClientRect().top >= row.getBoundingClientRect().bottom - 1 : false,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      // the panel's OWN planned figure, so the delta is checked against what
      // the rider is actually reading rather than against the fixture's maths
      rideHrs: Number([...document.querySelectorAll('.stat')]
        .find((el) => /Ride hrs/.test(el.textContent))?.querySelector('.n')?.textContent),
    };
  });
  console.log(`   ${line.text}`);
  check(/2h 55m|175/.test(line.text ?? ''), `it reads the predicted time (${line.text})`);
  // The "Ride hrs" stat is rounded to a tenth of an hour for display; the
  // line computes from the unrounded figure, so allow the minute that costs.
  const expectedDelta = Math.round(175 - line.rideHrs * 60);
  const shownDelta = Number(/\+(\d+) min/.exec(line.text ?? '')?.[1]);
  check(Number.isFinite(shownDelta) && Math.abs(shownDelta - expectedDelta) <= 1,
    `and what that adds over the panel's own free-flowing figure (${line.rideHrs} h → 2h 55m, shows +${shownDelta} min)`);
  check(/predicted for/i.test(line.text ?? ''), 'it says which departure it is predicting');
  check(line.heavy, `a ${expectedDelta}-minute hit is flagged, not buried`);
  check(line.belowStats, 'it sits under the day figures it qualifies');
  check(!line.sideways, 'nothing scrolls sideways');

  const body = gCalls.at(-1);
  check(typeof body?.departureTime === 'string', 'the request asks about the DEPARTURE, not about now');
  check(body?.departureTime?.startsWith(IN_TWO_DAYS), `…on the day's own date (${body?.departureTime})`);
  check(body?.purpose === 'eta', 'and is tagged an ETA ask, never a route replacement');

  // ---- a day already ridden ----
  const before = gCalls.length;
  await openDay(0);
  await page.waitForTimeout(2500);
  check(await page.locator('.day-traffic').count() === 0, 'a day already ridden asks nothing and shows nothing');
  check(gCalls.length === before, `and costs no Pro-SKU call (${gCalls.length - before})`);

  // ---- cost discipline ----
  await openDay(1);
  await page.waitForSelector('.day-traffic:not(.asking)', { timeout: 15000 });
  await openDay(0);
  await page.waitForTimeout(400);
  await openDay(1);
  await page.waitForSelector('.day-traffic:not(.asking)', { timeout: 15000 });
  check(gCalls.length === before, `revisiting the day is free — the answer is cached (${gCalls.length - before} extra)`);

  // ---- the trip overview (owner, Sep 20 2026: "yes add it to the trip
  // overview too") — the whole trip's traffic cost, and each day's ----
  const sweepBefore = gCalls.length;
  await page.locator('.rchip', { hasText: 'Trip' }).first().click();
  await page.waitForSelector('.ov-days', { timeout: 10000 });
  await page.waitForTimeout(3000);
  const ov = await page.evaluate(() => ({
    chip: document.querySelector('.chip.traffic')?.textContent?.trim() ?? null,
    perDay: [...document.querySelectorAll('.ov-day')].map((d) => ({
      when: d.querySelector('.dt')?.innerText.replace(/\n/g, ' '),
      traffic: d.querySelector('.ov-traffic')?.textContent ?? null,
    })),
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  console.log(`   trip chip: ${ov.chip} · ${ov.perDay.map((d) => `${d.when}=${d.traffic}`).join(' ')}`);
  check(!!ov.chip, `the trip carries its whole traffic cost (${ov.chip})`);
  check(/\+\d/.test(ov.chip ?? ''), 'as a delta a rider can act on');
  check(ov.perDay.filter((d) => d.traffic).length === 1,
    `only the day still ahead carries one (${ov.perDay.filter((d) => d.traffic).length})`);
  check(/\+3[67]m/.test(ov.perDay.find((d) => d.traffic)?.traffic ?? ''),
    `and it is that day's own figure (${ov.perDay.find((d) => d.traffic)?.traffic})`);
  check(!ov.sideways, 'the overview still scrolls on one axis');
  check(gCalls.length === sweepBefore,
    `the sweep re-used what the day panel already bought (${gCalls.length - sweepBefore} new calls)`);

  check(errors.length === 0, `no page errors (${errors.length})`);
  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await run(375, 'phone, no Google key', { keyed: false });
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
