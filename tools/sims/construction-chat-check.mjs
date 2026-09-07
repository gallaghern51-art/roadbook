import { chromium } from '../../node_modules/playwright-core/index.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const SHOT = (name) => new URL(`./shots/${name}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const options = (revision = 1) => [
  {
    id: `mountain-${revision}`, title: 'Passes + hot springs', summary: 'Best blend of roads and recovery',
    routeDescription: 'US-550 over the San Juan passes, then a verified hot-springs stay that sets up the next morning.',
    why: 'The signature road, lunch and overnight form one coherent day instead of three unrelated pins.',
    groupFit: 'Fuel is inside the comfort range and the long meal stop works for four bikes.',
    tradeoff: 'Adds mountain weather exposure and 48 minutes over the quickest choice.',
    metrics: { miles: 238, rideMinutes: 326, dwellMinutes: 95, totalMinutes: 421, arrival: '15:01', longestFuelGap: 112, ascentFeet: 8100, deltaMiles: 27, deltaMinutes: 48 },
    locations: [
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'start' },
      { name: revision === 1 ? 'Million Dollar Highway' : 'Coal Bank Pass', lat: 37.9, lng: -107.67, kind: 'road', detail: 'US-550' },
      { name: 'Conoco, Ouray', lat: 38.02, lng: -107.67, kind: 'fuel', placeId: 'fuel-1', detail: 'Verified on the route' },
      { name: 'Brickhouse 737', lat: 38.02, lng: -107.67, kind: 'food', placeId: 'food-1', detail: 'Verified lunch' },
      { name: 'Ouray Hot Springs', lat: 38.03, lng: -107.67, kind: 'lodging', placeId: 'stay-1', detail: 'Recovery-night anchor' },
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'end' },
    ],
  },
  {
    id: `canyon-${revision}`, title: 'Canyons + local food', summary: 'Lower exposure, strongest meal stop',
    routeDescription: 'A lower-elevation canyon line with a destination lunch and a simpler fuel pattern.',
    why: 'Keeps the day social and scenic without committing the group to every high pass.',
    groupFit: 'The easiest parking and shortest fuel gap of the three options.',
    tradeoff: 'Misses one headline pass and has less climbing drama.',
    metrics: { miles: 211, rideMinutes: 278, dwellMinutes: 85, totalMinutes: 363, arrival: '14:03', longestFuelGap: 84, ascentFeet: 5100, deltaMiles: 0, deltaMinutes: 0 },
    locations: [
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'start' },
      { name: 'Unaweep Canyon', lat: 38.8, lng: -108.4, kind: 'road', detail: 'CO-141' },
      { name: 'Gateway Canyons Grill', lat: 38.68, lng: -108.97, kind: 'food', placeId: 'food-2', detail: 'Verified lunch' },
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'end' },
    ],
  },
  {
    id: `ridges-${revision}`, title: 'Long ridge day', summary: 'Most riding, latest arrival',
    routeDescription: 'Links two high ridges and a late-afternoon attraction before returning.',
    why: 'Maximum road character for a group that wants the bike to be the main event.',
    groupFit: 'Works only if everyone accepts a long saddle day and disciplined stops.',
    tradeoff: 'Longest day, largest fuel gap and latest arrival.',
    metrics: { miles: 286, rideMinutes: 392, dwellMinutes: 70, totalMinutes: 462, arrival: '15:42', longestFuelGap: 158, ascentFeet: 10300, deltaMiles: 75, deltaMinutes: 114 },
    locations: [
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'start' },
      { name: 'Red Mountain Pass', lat: 37.9, lng: -107.71, kind: 'road' },
      { name: 'Telluride', lat: 37.94, lng: -107.81, kind: 'attraction' },
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'end' },
    ],
  },
];

const generatedTrip = {
  meta: { title: 'San Juan Roadbook', subtitle: 'Built in conversation', summary: 'A confirmed two-day San Juan plan.', riders: 4 },
  days: [
    { title: 'Durango → Ouray', phase: 'outbound', depart: '8:00 AM', summary: 'US-550 and the selected stops.', waypoints: [
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'start' },
      { name: 'Conoco, Ouray', lat: 38.02, lng: -107.67, kind: 'fuel', fuel: true, placeId: 'fuel-1' },
      { name: 'Ouray', lat: 38.0228, lng: -107.6714, kind: 'end' },
    ], meals: [{ meal: 'lunch', name: 'Brickhouse 737', where: 'Ouray' }], lodging: { status: 'reserve', name: 'Ouray Hot Springs', where: 'Ouray' } },
    { title: 'Ouray → Durango', phase: 'return', depart: '9:00 AM', summary: 'The return leg.', waypoints: [
      { name: 'Ouray', lat: 38.0228, lng: -107.6714, kind: 'start' },
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'end' },
    ], meals: [], lodging: { status: 'none', name: '', where: '' } },
  ],
};

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
const errors = [];
let exploreCalls = 0, generateCalls = 0;
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.includes('/.netlify/functions/planner-background')) return route.fulfill({ status: 404, body: 'not available' });
  if (url.includes('/.netlify/functions/chat')) {
    const body = route.request().postDataJSON();
    let done;
    if (body.mode === 'explore') {
      exploreCalls++;
      done = { type: 'done', text: exploreCalls === 1 ? 'I found three ways to make the San Juans work. The first is the strongest overall blend.' : 'I replaced that road piece and rechecked the comparison.', concepts: options(exploreCalls), recommendedId: `mountain-${exploreCalls}`, ms: 1200 };
    } else {
      generateCalls++;
      done = { type: 'done', trip: generatedTrip, verify: null, ms: 900 };
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: `${JSON.stringify({ type: 'start', ms: 0 })}\n${JSON.stringify(done)}\n`,
    });
  }
  if (url.includes('127.0.0.1:5199')) return route.continue();
  return route.abort();
});

await page.goto('http://127.0.0.1:5199/');
const guest = page.locator('.land-skip');
if (await guest.isVisible().catch(() => false)) await guest.click();
await page.waitForSelector('.home-intake textarea', { timeout: 15000 });
await page.fill('.home-intake textarea', 'Four riders, six days in the San Juans. Great roads, reliable fuel, one hot-springs night and memorable local food.');
await page.locator('.home-intake .btn', { hasText: 'Plan with AI' }).click();
await page.waitForSelector('.trip-builder');
check(await page.locator('.construction-chat').isVisible(), 'AI opens as a construction conversation');
check((await page.locator('.construction-composer textarea').inputValue()).includes('Four riders'), 'home prompt carries into the conversation');
await page.locator('.construction-composer .btn', { hasText: 'Explore the trip' }).click();
await page.waitForSelector('.concept-tabs button');
check(await page.locator('.concept-tabs button').count() === 3, 'planner presents three selectable route options');
check((await page.locator('.concept-facts').innerText()).includes('max fuel gap'), 'selected option exposes measured route and fuel facts');
check(await page.locator('.concept-stops li').count() >= 5, 'selected option exposes its ordered road and stop pieces');
check(await page.locator('.construction-confirm').getByText('Nothing is created yet.').isVisible(), 'trip stays uncommitted while the rider refines it');
const phoneFits = await page.locator('.trip-builder').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
check(phoneFits, 'construction workbench fits a phone without horizontal clipping');
await page.screenshot({ path: SHOT('construction-chat-phone'), fullPage: true });

await page.locator('.concept-stops li', { hasText: 'Million Dollar Highway' }).getByText('Change').click();
check((await page.locator('.construction-composer textarea').inputValue()).includes('Replace Million Dollar Highway'), 'a stop-level action becomes a precise follow-up prompt');
await page.locator('.construction-composer .btn', { hasText: 'Send' }).click();
await page.getByText('Coal Bank Pass', { exact: true }).waitFor();
check(exploreCalls === 2, 'piece-level refinement runs a fresh research/evaluation turn');
await page.locator('.concept-tabs button', { hasText: 'Canyons + local food' }).click();
check((await page.locator('.concept-selected').innerText()).includes('Unaweep Canyon'), 'rider can select a different assembled option');

await page.setViewportSize({ width: 1366, height: 900 });
await page.waitForTimeout(250);
const desktopFits = await page.locator('.trip-builder').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
check(desktopFits, 'construction workbench fits desktop without clipping');
await page.screenshot({ path: SHOT('construction-chat-desktop') });

await page.locator('.construction-confirm .btn', { hasText: 'Create this trip' }).click();
await page.waitForSelector('.modebar', { timeout: 10000 });
check(generateCalls === 1, 'final itinerary generation waits for explicit confirmation');
check((await page.locator('.brand').innerText()).includes('ROADBOOK'), 'confirmed plan lands in the trip workspace');
check(errors.length === 0, `no browser errors (${errors.join('; ') || 'none'})`);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
