// Grab the route line and pull it where you wanted the road to go.
//
// Owner request (Sep 7, 2026), after a Weehawken -> Nyack leg routed through
// the Lincoln Tunnel: "a user can grab a point on the route and drag to fix
// that… the engine needs to align that point with whatever leg that point is
// touching so it changes the right portion of route and gets added in right
// spot on the linear flow of the ride."
//
// The trip here is that exact shape: two stops, one leg, and a mocked router
// that swings the road east across the river and back. Dragging the middle of
// that detour west must add ONE via, inside that leg, at the drop point.
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
const R = 3958.8;
const hav = (a, b) => {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180, la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

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

// The road between two points on the WEST bank swings EAST across the river
// and back — the reported Lincoln Tunnel shape, in miniature. Any point on
// that bulge is far from the straight line between the two stops, which is
// exactly what makes the insertion decision interesting.
const detour = (a, b) => {
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [a, [a[0] + 0.09, a[1] + 0.02], [mid[0] + 0.11, mid[1]], [b[0] + 0.09, b[1] - 0.02], b];
};

const buildValhalla = (body) => {
  const locs = body.locations.map((l) => [l.lon, l.lat]);
  const legs = [];
  let totalMi = 0, totalSec = 0;
  for (let i = 0; i < locs.length - 1; i++) {
    // Only the original single leg detours; a leg that already has a via in it
    // is assumed fixed, so the drag's effect on the drawn line is visible.
    const pts = locs.length === 2 ? detour(locs[i], locs[i + 1]) : [locs[i], locs[i + 1]];
    const mi = pts.slice(1).reduce((sum, p, j) => sum + hav(pts[j], p), 0);
    const sec = (mi / 45) * 3600;
    totalMi += mi; totalSec += sec;
    legs.push({
      shape: enc6(pts),
      summary: { length: mi, time: sec },
      maneuvers: [
        { type: 1, instruction: 'Ride on.', street_names: ['Main'], length: mi, time: sec, begin_shape_index: 0 },
        { type: 4, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: pts.length - 1 },
      ],
    });
  }
  return { trip: { summary: { length: totalMi, time: totalSec }, legs, units: 'miles' } };
};

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
// Uncaught exceptions only. Every non-localhost request is aborted by design
// in this harness, so tile fetch failures are the mock, not a defect.
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.includes('localhost:5199') || u.includes('127.0.0.1:5199')) return r.continue();
  if (u.includes('valhalla1.openstreetmap.de/route')) {
    return r.fulfill({ json: buildValhalla(r.request().postDataJSON()) });
  }
  return r.abort();
});

await page.addInitScript(() => {
  const real = window.prompt;
  window.prompt = (...args) => { window.__promptCalled = true; return real?.apply(window, args); };
});
await page.goto('http://127.0.0.1:5199/');
const guest = page.locator('.land-skip');
if (await guest.isVisible().catch(() => false)) await guest.click();
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForTimeout(500);

const START = [-74.0175, 40.768];   // 1500 Harbor Blvd, Weehawken
const END = [-73.9182, 41.0912];    // Nyack

await page.evaluate(([start, end]) => {
  const mk = (id, name, lng, lat, kind) => ({ id, kind, name, lat, lng, mile: null, note: '' });
  window.__dispatch({
    type: 'create_trip',
    name: 'DRAG TEST',
    trip: {
      meta: { title: 'DRAG TEST', subtitle: '', summary: '', riders: 1, startDate: '2026-09-07', fuelRule: '', range: 200, roster: [], routePrefs: { style: 'touring', avoidTolls: false } },
      days: [{
        id: 'd1', dow: 'Mon', date: '2026-09-07', title: 'Upstate loop', phase: 'rally',
        miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '',
        constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
        lodging: { status: 'none', name: '', where: '', note: '' },
        waypoints: [mk('w-start', 'Weehawken', start[0], start[1], 'start'), mk('w-end', 'Nyack', end[0], end[1], 'end')],
      }],
      reserveNow: [],
    },
  });
}, [START, END]);
await page.waitForTimeout(800);
// The first ribbon chip is the whole-trip view; the day chips follow it.
await page.locator('.rchip').nth(1).click();
await page.waitForSelector('.wp-row', { timeout: 10000 });
await page.waitForTimeout(2500);

// The reducer persists on every apply_ops, so localStorage is the trip's truth.
const stops = () => page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('moto.trips.v1'));
  const rec = lib.trips.find((t) => t.id === lib.activeId) ?? lib.trips[0];
  return rec.trip.days[0].waypoints.map((w) => ({ name: w.name, kind: w.kind, lat: w.lat, lng: w.lng }));
});

// ---------------------------------------------------------------- the setup
const geo = await page.evaluate(() => {
  const m = window.__map;
  const src = m.getSource('route-d1');
  return src?._data?.geometry?.coordinates ?? null;
});
check(Array.isArray(geo) && geo.length >= 4, `the day is routed with a detouring line (${geo?.length ?? 0} vertices)`);

const dragLayers = await page.evaluate(() => window.__map.getStyle().layers.map((l) => l.id).filter((id) => id.startsWith('route-drag')));
check(dragLayers.length === 3, `the drag proposal has its own layers (${dragLayers.join(', ') || 'none'})`);

// Screen position of the middle of the detour bulge, and a drop target back on
// the west bank at the same latitude.
const pxOf = async (lngLat) => page.evaluate((ll) => {
  const m = window.__map;
  const p = m.project(ll);
  const r = m.getCanvas().getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, lngLat);

const bulge = geo[Math.floor(geo.length / 2)];
const target = [bulge[0] - 0.085, bulge[1]]; // pull it due west, back into NJ
const from = await pxOf(bulge);
const to = await pxOf(target);
check(Math.abs(from.x - to.x) > 30, `the drag covers real screen distance (${Math.round(Math.abs(from.x - to.x))}px)`);

// --------------------------------------------------- the drag itself: cancel
await page.mouse.move(from.x, from.y);
await page.waitForTimeout(150);
const grabCursor = await page.evaluate(() => window.__map.getCanvas().style.cursor);
check(grabCursor === 'grab', `hovering the line of the day you are editing offers a grab cursor (${grabCursor || 'none'})`);

await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 12 });
await page.waitForTimeout(120);
const midDrag = await page.evaluate(() => {
  const m = window.__map;
  return {
    band: m.getSource('route-drag')?._data?.geometry?.coordinates?.length ?? 0,
    handle: m.getSource('route-drag-pt')?._data?.features?.length ?? 0,
    panDisabled: !m.dragPan.isEnabled(),
    cursor: m.getCanvas().style.cursor,
    cls: document.querySelector('.map-wrap')?.className.includes('route-dragging'),
  };
});
check(midDrag.band === 3, `a rubber band spans stop → cursor → stop while dragging (${midDrag.band} points)`);
check(midDrag.handle === 1, 'a handle marks the point being placed');
check(midDrag.panDisabled, 'the map does not pan out from under the drag');
check(midDrag.cursor === 'grabbing', `the cursor says the line is held (${midDrag.cursor})`);
check(midDrag.cls === true, 'the map wrapper reports the dragging state');
await page.screenshot({ path: SHOT('route-drag-live') });

await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const cancelled = await page.evaluate(() => ({
  band: window.__map.getSource('route-drag')?._data?.geometry?.coordinates?.length ?? 0,
  panEnabled: window.__map.dragPan.isEnabled(),
}));
check(cancelled.band === 0, 'Escape clears the proposal');
check(cancelled.panEnabled, 'Escape gives the map back its pan');
check((await stops()).length === 2, 'a cancelled drag adds nothing');
await page.mouse.up();
await page.waitForTimeout(200);

// ------------------------------------------------- the drag itself: commit
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(1200);

const after = await stops();
check(after.length === 3, `the drop adds exactly one stop (${after.length})`);
check(after[1]?.kind === 'via', `the new stop is a via (${after[1]?.kind})`);
check(after[0]?.name === 'Weehawken' && after[2]?.name === 'Nyack',
  `the day still starts and ends where it did (${after[0]?.name} → ${after[2]?.name})`);
const dropped = after[1];
const offTarget = dropped ? hav([dropped.lng, dropped.lat], target) : 999;
check(offTarget < 1.5, `the via lands where it was dropped (${offTarget.toFixed(2)} mi off)`);
check(dropped && dropped.lng < bulge[0] - 0.05,
  `the via is west of the road it was pulled off (${dropped?.lng.toFixed(4)} vs ${bulge[0].toFixed(4)})`);

// The point of the whole feature: the route now goes through it.
await page.waitForTimeout(1500);
const rerouted = await page.evaluate(() => {
  const m = window.__map;
  const coords = m.getSource('route-d1')?._data?.geometry?.coordinates ?? [];
  return coords;
});
const nearest = rerouted.reduce((best, c) => Math.min(best, hav(c, [dropped.lng, dropped.lat])), Infinity);
check(nearest < 0.5, `the redrawn route passes through the dropped point (${nearest.toFixed(2)} mi)`);
await page.screenshot({ path: SHOT('route-drag-done') });

// ------------------------------------------- day panel order (the linear flow)
const rows = await page.locator('.wp-row').allTextContents().catch(() => []);
const order = rows.map((r) => r.replace(/\s+/g, ' ').trim());
check(order.length === 3 && /Weehawken/.test(order[0]) && /Nyack/.test(order[2]),
  `the day panel lists the new stop between the two it belongs between (${order.length} rows)`);

// ------------------------------------------------ tap-to-add names its stop
// Well clear of the map's own overlays (the editing hint, the layers pill).
const canvas = await page.evaluate(() => {
  const r = window.__map.getCanvas().getBoundingClientRect();
  return { x: r.left + r.width * 0.35, y: r.top + r.height * 0.75 };
});
await page.mouse.click(canvas.x, canvas.y);
await page.waitForTimeout(400);
const sheet = await page.locator('.sheet').count();
check(sheet === 1, `clicking open map opens the naming sheet rather than window.prompt (${sheet})`);
const promptUsed = await page.evaluate(() => window.__promptCalled === true);
check(!promptUsed, 'window.prompt is not used');
await page.locator('.sheet input').fill('Palisades Parkway');
await page.locator('.sheet .btn.gold').click();
await page.waitForTimeout(900);
const withTap = await stops();
check(withTap.length === 4 && withTap.some((w) => w.name === 'Palisades Parkway'),
  `the named stop is added (${withTap.length} stops)`);
check(withTap[0].name === 'Weehawken' && withTap[withTap.length - 1].name === 'Nyack',
  'a tapped stop never displaces the day’s endpoints');

// The marker hover tooltip lives in the same function as the drag's own
// markers, and its i18n call was shadowed by a `trip: t` destructure — it threw
// on every stop hover, so no tooltip ever appeared.
const marker = page.locator('.wp-marker').first();
await marker.hover();
await page.waitForTimeout(400);
const tip = await page.locator('.pp-name').count();
check(tip === 1, `hovering a stop shows its tooltip (${tip})`);

check(errors.length === 0, `no browser errors (${errors.slice(0, 2).join(' | ') || 'none'})`);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
