// The route sheet: the ride before it is ridden (owner, Sep 19–20, 2026).
//
//   "when someone just types in a destination and cancels ride mode, it takes
//    me to the planning mode. how can we make it easier to edit destination
//    and add stops?"
//   "on the from, to screen there should be an add stop option on there
//    before 'go'."
//   "it doesn't allow user to see the different recommended routes per
//    selection 'quick, touring, back roads'… like google maps/apple maps does
//    before they select."
//   "and put expected toll cost for each option if theres tolls"
//
// Four asks, one surface. This drives it end to end at phone and desktop
// width: the options measured and drawn, a stop added between From and To,
// Go, and — the headline — cancelling Ride Mode landing back HERE instead of
// in the trip workspace.
//
//   npm run dev    # :5199
//   node tools/sims/route-sheet-check.mjs
//   node tools/sims/route-sheet-check.mjs --live   # real Valhalla + the
//        DEPLOYED functions, so traffic, tolls and Places are live data.
//        The Google key lives in the Netlify site env and is masked on read,
//        so the sim borrows the deployed function rather than the key.

import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';
import { seedRideAck } from './fixtures/ride-ack.mjs';

const LIVE = process.argv.includes('--live');
const DEPLOYED = 'https://roadbook-app.netlify.app';
const PORT = process.env.RB_PORT ?? '5199';
const BASE = `http://localhost:${PORT}`;

let pass = 0; let fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (ok) pass++; else fail++; };

// ---- the mocked world ----
// Eastern Long Island → Montauk: the owner's own corridor, and the one where
// the traffic gap was measured (104 mi reading 129 min free-flow against 154
// min in live traffic).
const ME = { lat: 40.9634, lng: -72.1848 };
const DEST = { lat: 41.0714, lng: -71.8573, name: 'Montauk Point Light' };

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const enc6 = (pts) => {
  let out = ''; let plat = 0; let plng = 0;
  const enc = (v0) => { let s = ''; let v = v0 < 0 ? ~(v0 << 1) : (v0 << 1); while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lng, lat] of pts) { const a = Math.round(lat * 1e6); const b = Math.round(lng * 1e6); out += enc(a - plat) + enc(b - plng); plat = a; plng = b; }
  return out;
};
// a road bowed off the straight line, so two candidates are visibly different
const shapeOf = (locs, bow) => {
  const pts = [];
  for (let i = 0; i < locs.length - 1; i++) {
    for (let s = 0; s < 12; s++) {
      const f = s / 12;
      const [x, y] = lerp(locs[i], locs[i + 1], f);
      pts.push([x, y + Math.sin(f * Math.PI) * bow]);
    }
  }
  pts.push(locs[locs.length - 1]);
  return pts;
};
const legOf = (locs, bow, miles, mins, road) => ({
  shape: enc6(shapeOf(locs, bow)),
  summary: { length: miles, time: mins * 60 },
  maneuvers: [
    { type: 1, instruction: `Ride ${road}.`, street_names: [road], length: miles, time: mins * 60, begin_shape_index: 0, toll: bow === 0 },
    { type: 4, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: 1 },
  ],
});
const vCalls = [];
function valhalla(body) {
  vCalls.push(body);
  const locs = body.locations.map((l) => [l.lon, l.lat]);
  const hw = body.costing_options.motorcycle.use_highways;
  const multi = locs.length > 2;
  // back roads is its own, slower road; quick and touring converge — exactly
  // what the live server does on this corridor
  const spec = hw <= 0.05
    ? { bow: 0.09, miles: 24 + (multi ? 6 : 0), mins: 41 + (multi ? 12 : 0), road: 'Old Montauk Highway', toll: false }
    : { bow: 0, miles: 20 + (multi ? 6 : 0), mins: 27 + (multi ? 12 : 0), road: 'NY 27', toll: true };
  const legs = [];
  for (let i = 0; i < locs.length - 1; i++) {
    legs.push(legOf([locs[i], locs[i + 1]], spec.bow, spec.miles / (locs.length - 1), spec.mins / (locs.length - 1), spec.road));
  }
  const trip = {
    legs,
    summary: { length: spec.miles, time: spec.mins * 60, has_toll: spec.toll },
    status: 0,
    units: 'miles',
  };
  // alternates ONLY for a two-point request — the measured behaviour
  const alternates = (!multi && hw > 0.05)
    ? [{ trip: { legs: [legOf(locs, 0.05, 22, 33, 'Sunrise Highway')], summary: { length: 22, time: 33 * 60, has_toll: false }, status: 0, units: 'miles' } }]
    : [];
  return alternates.length ? { trip, alternates } : { trip };
}

const STOPS = [
  { id: 'g-lobster', name: 'Lobster Roll', detail: 'Montauk Hwy, Amagansett NY', lat: 40.9749, lng: -72.1085, rating: 4.3, userRatingCount: 1200, primaryType: 'restaurant', types: ['restaurant'], status: 'OPERATIONAL', openNow: true },
  { id: 'g-fuel', name: 'Amagansett Fuel', detail: 'Main St, Amagansett NY', lat: 40.9761, lng: -72.1431, rating: 4.0, userRatingCount: 60, primaryType: 'gas_station', types: ['gas_station'], status: 'OPERATIONAL', openNow: true },
];
let gRouteCalls = [];

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function run(width, label, { noFix = false } = {}) {
  console.log(`\n── ${label} (${width}px)${LIVE ? ' LIVE' : ''} ──`);
  const phone = width < 820;
  const ctx = await browser.newContext({ viewport: { width, height: 812 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('PAGEERROR', e.message); });
  gRouteCalls = [];
  let valhallaHits = 0;
  const valhallaBodies = [];
  page.on('request', (rq) => {
    if (!rq.url().includes('valhalla1.openstreetmap.de/route')) return;
    valhallaHits += 1;
    try { valhallaBodies.push(JSON.parse(rq.postData() ?? '{}')); } catch { /* not ours */ }
  });

  await page.route('**/*', async (r) => {
    const u = r.request().url();
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes('/.netlify/functions/')) {
      if (u.includes('google-route')) gRouteCalls.push(r.request().postDataJSON());
      if (LIVE) {
        // the deployed function holds the key: live traffic, tolls and Places
        const res = await fetch(DEPLOYED + new URL(u).pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: r.request().postData() ?? '{}',
        }).catch(() => null);
        if (!res) return r.fulfill({ status: 502, json: { error: 'deployed unreachable' } });
        return r.fulfill({ status: res.status, body: await res.text(), headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('nearby-places')) return r.fulfill({ json: STOPS });
      if (u.includes('place-details')) return r.fulfill({ status: 404, json: {} });
      if (u.includes('google-route')) {
        // live traffic answers slower than the road, and prices the toll
        return r.fulfill({ json: { geometry: [[-72.18, 40.96], [-71.86, 41.07]], distanceMeters: 32187, durationSeconds: 2520, toll: { currency: 'USD', amount: 6.5 } } });
      }
      return r.fulfill({ status: 404, json: {} });
    }
    if (u.includes('valhalla1.openstreetmap.de/route')) {
      if (LIVE) return r.continue();
      return r.fulfill({ json: valhalla(r.request().postDataJSON()) });
    }
    if (u.includes('router.project-osrm.org')) return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
    if (u.startsWith(BASE)) return r.continue();
    return r.abort();
  });

  await page.addInitScript(({ me, deny }) => {
    const stub = deny
      ? { getCurrentPosition: (_ok, err) => err?.({ code: 1, message: 'denied' }), watchPosition: (_ok, err) => { err?.({ code: 1 }); return 1; }, clearWatch: () => {} }
      : {
        getCurrentPosition: (ok) => ok({ coords: { latitude: me.lat, longitude: me.lng, accuracy: 5, speed: 0, heading: 0 }, timestamp: Date.now() }),
        watchPosition: (ok) => { window.__geoCb = ok; ok({ coords: { latitude: me.lat, longitude: me.lng, accuracy: 5, speed: 0, heading: 0 }, timestamp: Date.now() }); return 1; },
        clearWatch: () => {},
      };
    Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
  }, { me: ME, deny: noFix });
  await seedRideAck(page);
  await page.goto(`${BASE}/`);
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.home-map', { timeout: 20000 });
  await page.waitForTimeout(1500);

  // ---- open a place, then Ride here ----
  await page.evaluate((d) => window.__homePoiTap(
    { properties: { name: d.name, class: 'tourism', subclass: 'attraction' }, geometry: { type: 'Point', coordinates: [d.lng, d.lat] } },
    { lng: d.lng, lat: d.lat },
  ), DEST);
  await page.waitForSelector('.hm-place', { timeout: 10000 });
  await page.waitForTimeout(700);
  await page.locator('.hm-place .btn', { hasText: 'Ride here' }).first().click();

  const opened = await page.waitForSelector('.route-sheet', { timeout: 10000 }).then(() => true).catch(() => false);
  check(opened, 'Ride here opens the route sheet');
  if (!opened) { await ctx.close(); return; }

  if (noFix) {
    // location denied: the sheet still opens and says what is missing, rather
    // than the tap doing nothing at all (which is what it used to do)
    const s = await page.evaluate(() => ({
      from: document.querySelector('.rs-from .rs-v')?.textContent,
      go: document.querySelector('.rs-actions .btn')?.disabled,
    }));
    check(s.from === 'Pick a start', `no fix: From reads "Pick a start" (${s.from})`);
    check(s.go === true, 'no fix: Go is disabled until there is a start');
    await ctx.close();
    return;
  }

  await page.waitForFunction(() => document.querySelectorAll('.rs-opt').length > 0, null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1200);

  // ---- 1. the ride is laid out, and the map still has room ----
  const lay = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const r = (e) => (e ? e.getBoundingClientRect() : null);
    const sheet = r(q('.hm-sheet'));
    const vis = (e) => { const b = r(e); return !!b && b.top >= 0 && b.bottom <= innerHeight && b.height > 0; };
    return {
      from: q('.rs-from .rs-v')?.textContent,
      to: q('.rs-to .rs-v')?.textContent,
      addVisible: vis(q('.rs-add')),
      fromVisible: vis(q('.rs-from')),
      toVisible: vis(q('.rs-to')),
      goVisible: vis(q('.rs-actions .btn')),
      sheetTop: sheet?.top ?? 0,
      vh: innerHeight,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  check(LIVE ? /montauk/i.test(lay.to ?? '') : lay.to === DEST.name, `To is the place that was tapped (${lay.to})`);
  check(!!lay.from && lay.from !== 'Pick a start', `From is the rider (${lay.from})`);
  check(lay.fromVisible && lay.toVisible, 'From and To are both on screen at a peek');
  check(lay.addVisible, 'Add a stop sits between them, above Go');
  check(lay.goVisible, 'Go is on screen without scrolling');
  check(width < 820 ? lay.sheetTop > 250 : true, `the map keeps its half (sheet starts at ${Math.round(lay.sheetTop)} of ${lay.vh})`);
  check(!lay.sideways, 'nothing scrolls sideways');

  // ---- 2. the options ----
  const opts = await page.evaluate(() => [...document.querySelectorAll('.rs-opt')].map((o) => ({
    label: o.querySelector('.rs-opt-head b')?.textContent,
    figs: o.querySelector('.rs-opt-figs')?.textContent,
    active: o.classList.contains('active'),
    fastest: !!o.querySelector('.rs-tag.fast'),
    toll: o.querySelector('.rs-toll')?.textContent ?? null,
    h: Math.round(o.getBoundingClientRect().height),
  })));
  console.log(`   ${opts.map((o) => `${o.label} ${o.figs}`).join('\n   ')}`);
  check(opts.length >= 1, `roads are offered to choose between (${opts.length})`);
  check(opts.filter((o) => o.active).length === 1, 'exactly one option is selected');
  check(opts.every((o) => /\d/.test(o.figs ?? '')), 'every option carries its miles and its clock');
  check(opts.some((o) => o.fastest) || opts.length === 1, 'the fastest is marked when there is a choice');
  check(opts.every((o) => o.h >= 44), `every option is a glove-sized target (min ${Math.min(...opts.map((o) => o.h))}px)`);

  // ---- 3. the map draws them ----
  const drawn = await page.evaluate(() => {
    const m = window.__homeMap;
    const layers = m.getStyle().layers.filter((l) => l.id.startsWith('route-options')).map((l) => l.id);
    const src = m.getSource('route-options');
    const data = src?._data ?? src?.serialize?.().data;
    return {
      layers,
      features: data?.features?.length ?? 0,
      chosen: (data?.features ?? []).filter((f) => f.properties.chosen === 1).length,
      colour: m.getLayer('route-options-line') ? m.getPaintProperty('route-options-line', 'line-color') : null,
      bubbles: [...document.querySelectorAll('.ro-bubble')].map((b) => b.textContent),
      bubbleChosen: document.querySelectorAll('.ro-bubble.chosen').length,
    };
  });
  check(drawn.layers.includes('route-options-line'), 'the selected road is drawn');
  check(drawn.layers.includes('route-options-alt'), 'the roads not chosen are drawn under it');
  check(drawn.layers.includes('route-options-hit'), 'a wide hit line makes the map tappable');
  check(drawn.features === opts.length, `one line per option (${drawn.features} for ${opts.length})`);
  check(drawn.chosen === 1, 'exactly one line is the chosen one');
  check(drawn.colour === '#2f7bff', `the chosen road is the route blue (${drawn.colour})`);
  check(drawn.bubbles.length === opts.length, `every option wears its time on the map (${drawn.bubbles.length})`);
  check(drawn.bubbleChosen === 1, 'the chosen bubble is lit');

  // ---- 4. picking another road ----
  if (opts.length > 1) {
    await page.locator('.rs-opt').nth(1).click();
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => {
      const m = window.__homeMap;
      const src = m.getSource('route-options');
      const data = src?._data ?? src?.serialize?.().data;
      const chosen = (data?.features ?? []).findIndex((f) => f.properties.chosen === 1);
      return { chosen, activeIdx: [...document.querySelectorAll('.rs-opt')].findIndex((o) => o.classList.contains('active')) };
    });
    check(after.activeIdx === 1, 'tapping a row selects that road');
    check(after.chosen === 1, 'the map follows the row');
    await page.locator('.rs-opt').nth(0).click();
    await page.waitForTimeout(500);
  }

  // ---- 5. tolls ----
  const tolled = opts.filter((o) => o.toll);
  if (tolled.length) {
    check(true, `a tolled road says so (${tolled[0].toll.trim()})`);
    const priced = await page.waitForFunction(
      () => /[$€£]/.test(document.querySelector('.rs-opt.active .rs-toll')?.textContent ?? ''),
      null, { timeout: 20000 },
    ).then(() => true).catch(() => false);
    check(priced, 'the selected tolled road carries a price');
    check(gRouteCalls.some((c) => c.tolls === true), 'the price was asked for explicitly (an extra computation, not a default)');
  } else {
    console.log('   (no tolled option on this corridor — nothing to price)');
  }

  // ---- 6. traffic ----
  await page.waitForFunction(
    () => !/Checking traffic/.test(document.querySelector('.rs-opt.active .rs-opt-traffic')?.textContent ?? 'Checking traffic'),
    null, { timeout: 25000 },
  ).catch(() => {});
  const traf = await page.evaluate(() => document.querySelector('.rs-opt.active .rs-opt-traffic')?.textContent ?? '');
  check(/traffic|Free-flowing/i.test(traf) && !/Checking/.test(traf), `the clock is answered as well as the road (${traf.trim().slice(0, 60)})`);
  check(gRouteCalls.some((c) => c.purpose === 'eta'), 'traffic is asked for as an ETA, never as a route replacement');

  // ---- 7. add a stop: the face from the recording ----
  await page.locator('.rs-add').click();
  await page.waitForSelector('.nearby-tiles', { timeout: 10000 });
  const picker = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.nb-tile')];
    const field = document.querySelector('.nearby-tiles .nb-q');
    const r = (e) => e.getBoundingClientRect();
    return {
      title: document.querySelector('.nearby-tiles .nb-title b')?.textContent,
      tiles: tiles.length,
      tileMin: Math.min(...tiles.map((t) => r(t).height)),
      tileLabels: tiles.map((t) => t.querySelector('span')?.textContent),
      fieldTop: field ? r(field).top : -1,
      tilesTop: tiles.length ? r(tiles[0]).top : -1,
      fieldSize: field ? parseFloat(getComputedStyle(field).fontSize) : 0,
      onMap: !!document.querySelector('.nb-onmap'),
      placeholder: field?.placeholder,
    };
  });
  check(/Add a stop/i.test(picker.title ?? ''), `the picker names the job (${picker.title})`);
  check(picker.tiles >= 6, `categories are tiles, not a strip of pills (${picker.tiles})`);
  check(picker.tileMin >= 60, `every tile is a glove target (min ${picker.tileMin}px)`);
  check(picker.fieldTop < picker.tilesTop, 'the field leads, as it does in the recording');
  check(picker.fieldSize >= 16, `the field is 16px so iOS does not zoom (${picker.fieldSize})`);
  check(picker.onMap, '"Choose on map" is offered');
  // the add-a-stop face IS the picker: it takes the picker's room, or the
  // tiles run off the bottom of a 58% frame measured for From/To/options/Go.
  // The sheet ANIMATES between detents — measure once it has settled, or the
  // reading is whatever height the transition happened to be passing through.
  await page.waitForFunction(() => {
    const el = document.querySelector('.hm-sheet');
    const h = el.getBoundingClientRect().height;
    if (window.__lastSheetH === h) return true;
    window.__lastSheetH = h;
    return false;
  }, null, { timeout: 5000, polling: 120 }).catch(() => {});
  const room = await page.evaluate(() => {
    const sh = document.querySelector('.hm-sheet');
    const tiles = [...document.querySelectorAll('.nb-tile')];
    const onMap = document.querySelector('.nb-onmap');
    return {
      pick: sh.classList.contains('pick'),
      h: Math.round(sh.getBoundingClientRect().height),
      vh: innerHeight,
      lastTile: Math.round(tiles[tiles.length - 1].getBoundingClientRect().bottom),
      onMapBottom: Math.round(onMap.getBoundingClientRect().bottom),
      scrolls: sh.querySelector('.hm-body').scrollHeight > sh.querySelector('.hm-body').clientHeight + 2,
    };
  });
  check(room.pick, 'the sheet takes the picker\'s surface while it is the picker');
  check(width >= 820 || room.h > room.vh * 0.6, `and the picker's room (${room.h} of ${room.vh})`);
  check(room.lastTile <= room.vh || room.scrolls, `every tile is reachable (last tile at ${room.lastTile}, scrolls: ${room.scrolls})`);
  check(/along route/i.test(picker.placeholder ?? ''), `the field says where it is looking (${picker.placeholder})`);

  await page.locator('.nb-tile', { hasText: 'Food' }).first().click();
  await page.waitForSelector('.nb-list .nb-item', { timeout: 20000 });
  await page.locator('.nb-list .nb-main').first().click();
  await page.waitForSelector('.nb-actions .btn', { timeout: 10000 });
  const stopName = await page.evaluate(() => document.querySelector('.nb-item.open .nb-name')?.textContent);
  await page.locator('.nb-actions .btn', { hasText: 'Add to the day' }).first().click();

  const hitsBeforeStop = valhallaHits;
  await page.waitForSelector('.rs-via', { timeout: 10000 });
  const withStop = await page.evaluate(() => ({
    order: [...document.querySelectorAll('.rs-stop')].map((s) => s.className.replace('rs-stop ', '')),
    via: document.querySelector('.rs-via .rs-v')?.textContent,
    remove: !!document.querySelector('.rs-via .mini-edit'),
  }));
  check(withStop.via === stopName, `the stop lands between From and To (${withStop.via})`);
  check(JSON.stringify(withStop.order) === JSON.stringify(['rs-from', 'rs-via', 'rs-to']), `in route order (${withStop.order.join(' → ')})`);
  check(withStop.remove, 'and can be taken off again');

  await page.waitForFunction(() => document.querySelectorAll('.rs-opt').length > 0, null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(800);
  const remeasured = await page.evaluate(() => [...document.querySelectorAll('.rs-opt')].map((o) => o.querySelector('.rs-opt-figs')?.textContent));
  check(remeasured.length >= 1, 'the roads are offered again with the stop on them');
  // The figures need not MOVE — a stop that sits on the road the rider was
  // already taking costs nothing, which is a real answer and was the live
  // result for a diner on NY-27. What must happen is the re-measure.
  check(valhallaHits > hitsBeforeStop, `and the route was measured again (${valhallaHits - hitsBeforeStop} requests)`);

  // ---- 8. Go, and the way back ----
  await page.locator('.rs-actions .btn', { hasText: 'Go' }).click();
  const rode = await page.waitForSelector('.ride-mode', { timeout: 20000 }).then(() => true).catch(() => false);
  check(rode, 'Go starts the ride');
  if (rode) {
    const trip = await page.evaluate(() => {
      const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
      const rec = l.trips.find((r) => r.id === l.activeId);
      return { quick: !!rec.trip.meta.quick, wps: rec.trip.days[0].waypoints.map((w) => ({ n: w.name, k: w.kind })), prefs: rec.trip.meta.routePrefs };
    });
    check(trip.quick, 'it is a real quick trip under the hood');
    check(trip.wps.length === 3, `start, the stop, the destination (${trip.wps.map((w) => w.n).join(' → ')})`);
    check(trip.wps[1].n === stopName, 'the added stop rides in the middle');
    check(trip.wps[0].k === 'start' && trip.wps[2].k === 'end', 'the ends are the ends');
    check(!!trip.prefs?.style, `the chosen road character is written onto the trip (${trip.prefs?.style})`);

    // ---- switching roads mid-ride ----
    // "if user wants to switch to a different quick, touring, backroads mid
    // ride they should be able to do that." It changes the road AHEAD; the
    // trip's own character is a planning act and must not be rewritten at
    // 70 mph.
    const prefsBefore = await page.evaluate(() => {
      const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
      return l.trips.find((r) => r.id === l.activeId).trip.meta.routePrefs;
    });
    const openSheet = page.locator('.ride-bar, .ride-sheet-open, [aria-label="Ride menu"]').first();
    await openSheet.click({ timeout: 8000 }).catch(() => {});
    const sheetUp = await page.waitForSelector('.ride-sheet', { timeout: 8000 }).then(() => true).catch(() => false);
    check(sheetUp, 'the ride sheet opens mid-ride');
    if (sheetUp) {
      const roadsRow = page.locator('.ride-sheet .rm-row', { hasText: 'Roads' }).first();
      check(await roadsRow.isVisible().catch(() => false), 'Roads sits with the other mid-ride controls');
      const segs = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.ride-sheet .rm-row')].find((r) => /Roads/.test(r.textContent));
        return [...(row?.querySelectorAll('.rm-seg button') ?? [])].map((b) => ({ t: b.textContent, h: Math.round(b.getBoundingClientRect().height), active: b.classList.contains('active') }));
      });
      check(segs.length === 3, `all three characters are offered (${segs.map((x) => x.t).join('/')})`);
      check(segs.every((x) => x.h >= 44), `each is a glove target (min ${Math.min(...segs.map((x) => x.h))}px)`);
      check(segs.filter((x) => x.active).length === 1, 'the one being ridden is lit');

      const before = valhallaHits;
      await page.locator('.ride-sheet .rm-row', { hasText: 'Roads' }).locator('button', { hasText: 'Back roads' }).click();
      await page.waitForTimeout(2500);
      check(valhallaHits > before, 'switching reroutes the road ahead');
      const last = valhallaBodies.at(-1);
      check(last?.costing_options?.motorcycle?.use_highways === 0.05,
        `and asks for the character the rider chose (use_highways ${last?.costing_options?.motorcycle?.use_highways})`);
      const note = await page.evaluate(() => document.querySelector('.ride-sheet .rm-note')?.textContent ?? '');
      check(/trip is unchanged/i.test(note), 'the rider is told the plan itself is untouched');
      const prefsAfter = await page.evaluate(() => {
        const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
        return l.trips.find((r) => r.id === l.activeId).trip.meta.routePrefs;
      });
      check(JSON.stringify(prefsAfter) === JSON.stringify(prefsBefore),
        `and the trip's own road character is NOT rewritten mid-ride (${prefsAfter?.style})`);
      await page.locator('.ride-sheet .sheet-x, .ride-sheet [aria-label="Close"]').first().click().catch(() => {});
      await page.waitForTimeout(400);
    }

    // THE headline fix
    const exit = page.locator('.ride-mode .ride-x, .ride-mode [aria-label="End navigation"], .ride-topbar button').first();
    await exit.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const back = await page.evaluate(() => ({
      home: !!document.querySelector('.home-map'),
      sheet: !!document.querySelector('.route-sheet'),
      plan: !!document.querySelector('.side-inner, .map-wrap'),
      via: document.querySelector('.rs-via .rs-v')?.textContent,
    }));
    check(back.home, 'cancelling the ride lands on the home map, not the trip workspace');
    check(back.sheet, 'the route sheet is still there');
    check(back.via === stopName, `with the ride intact (${back.via})`);
  }

  check(pageErrors.length === 0, `no page errors (${pageErrors.length})`);
  await ctx.close();
}

await run(375, 'phone');
await run(375, 'phone, location denied', { noFix: true });
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
