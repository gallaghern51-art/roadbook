// Trip-view markers are positional (day endpoints marked regardless of kind),
// and a day starting away from where yesterday ended raises an engine warning.
import { chromium } from '../../node_modules/playwright-core/index.mjs';
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.includes('localhost:5199')) return r.continue();
  if (u.includes('router.project-osrm.org')) {
    const m = /driving\/([^?]+)\?/.exec(u);
    const coords = m[1].split(';').map((p) => p.split(',').map(Number));
    const legs = coords.slice(1).map((c, i) => ({ distance: 50000, duration: 2000, annotation: { distance: [50000], duration: [2000] } }));
    return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 50000 * legs.length, duration: 2000 * legs.length, legs, geometry: { coordinates: coords } }], waypoints: coords.map((c) => ({ distance: 8, location: c })) } });
  }
  return r.abort();
});
await page.goto('http://localhost:5199/');
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForTimeout(600);

// Two AI-style days: every stop kind 'via' (no start/end kinds anywhere), and
// day 2 starts ~7 mi from day 1's end — the Bozeman disease.
await page.evaluate(() => {
  const mk = (id, name, lat, lng) => ({ id, kind: 'via', name, lat, lng, mile: null, note: '' });
  const dayBase = { miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '', constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [], lodging: { status: 'none', name: '', where: '', note: '' } };
  window.__dispatch({
    type: 'create_trip',
    name: 'GAP TEST',
    trip: {
      meta: { title: 'GAP TEST', subtitle: '', summary: '', riders: 1, startDate: '2026-08-13', fuelRule: '', range: 200, roster: [] },
      days: [
        { ...dayBase, id: 'g1', dow: 'Thu', date: '2026-08-13', title: 'Sturgis to Bozeman', phase: 'return', waypoints: [mk('g1a', 'Sturgis', 44.41, -103.51), mk('g1b', 'Sheridan fuel', 44.80, -106.96), mk('g1c', 'Bozeman (downtown)', 45.68, -111.04)] },
        { ...dayBase, id: 'g2', dow: 'Fri', date: '2026-08-14', title: 'Bozeman to Missoula', phase: 'return', waypoints: [mk('g2a', 'Bozeman (hotel)', 45.75, -111.15), mk('g2b', 'Butte', 46.00, -112.53), mk('g2c', 'Missoula', 46.87, -113.99)] },
      ],
      reserveNow: [],
    },
  });
});
await page.waitForTimeout(1500);
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);

// whole-trip view: 4 positional endpoint markers despite every kind being 'via'
const markers = await page.locator('.wp-marker').count();
check(markers === 4, `trip view marks all 4 day endpoints despite kind 'via' (${markers})`);
await page.screenshot({ path: SHOT('marker-trip') });

// day 2's panel carries the boundary-gap warning
await page.locator('.rchip', { hasText: '14' }).click();
await page.waitForSelector('.wp-row', { timeout: 8000 });
await page.waitForTimeout(400);
const warnings = await page.locator('.warning').allTextContents();
const gapWarn = warnings.find((w) => w.includes('Starts') && w.includes('ends'));
check(!!gapWarn, `day panel warns about the boundary gap ("${gapWarn ?? 'none'}")`);
check(gapWarn?.includes('Bozeman'), 'warning names both stops');
await page.screenshot({ path: SHOT('marker-gap-warn') });

// day 1 (no previous day) must NOT warn
await page.locator('.rchip', { hasText: '13' }).click();
await page.waitForTimeout(600);
const w1 = await page.locator('.warning').allTextContents();
check(!w1.some((w) => w.includes('Starts') && w.includes('ends')), 'first day has no boundary warning');

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
