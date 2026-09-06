// Trip settings: the pace field dispatches set_meta and retimes the plan.
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.includes('localhost:5199')) return route.continue();
  if (u.includes('router.project-osrm.org')) {
    const m = /driving\/([^?]+)\?/.exec(u);
    const coords = m[1].split(';').map((p) => p.split(',').map(Number));
    const legs = coords.slice(1).map((c, i) => {
      const a = coords[i], b = c;
      const R = 3958.8;
      const dLat = ((b[1] - a[1]) * Math.PI) / 180, dLng = ((b[0] - a[0]) * Math.PI) / 180;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      const meters = 2 * R * Math.asin(Math.sqrt(h)) * 1609.34;
      return { distance: meters, duration: meters / 25, annotation: { distance: [meters], duration: [meters / 25] } };
    });
    return route.fulfill({ json: {
      code: 'Ok',
      routes: [{ distance: legs.reduce((x, l) => x + l.distance, 0), duration: legs.reduce((x, l) => x + l.duration, 0), legs, geometry: { coordinates: coords } }],
      waypoints: coords.map((c) => ({ distance: 10, location: c })),
    } });
  }
  return route.abort();
});
await page.goto('http://localhost:5199/');
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForFunction(() => {
  try { return Object.keys(JSON.parse(localStorage.getItem('sturgis.routeCache.v2') || '{}')).length >= 3; } catch { return false; }
}, { timeout: 30000 });

// Overview panel hosts Trip settings (desktop: panel visible by default)
const paceInput = page.locator('label:has-text("Group pace buffer") input');
await paceInput.waitFor({ timeout: 10000 });
const before = await paceInput.inputValue();
const endBefore = await page.evaluate(() => document.body.innerText.match(/End ~\d{1,2}:\d{2} (AM|PM)/)?.[0] ?? null);
await paceInput.fill('25');
await page.waitForTimeout(800);
const meta = await page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('moto.trips.v1'));
  const rec = lib.trips.find((r) => r.id === lib.activeId);
  return (rec.trip ?? rec.working ?? rec).meta?.pace ?? null;
});
console.log('pace input before:', before, '→ meta.pace stored:', JSON.stringify(meta));
console.log(meta === 1.25 ? 'PASS set_meta pace stored' : 'CHECK meta shape (value above)');
await page.screenshot({ path: './shots/trip-settings.png' });
await browser.close();
