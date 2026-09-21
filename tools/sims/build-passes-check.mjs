// A long trip builds in PASSES, decided up front, landing as it goes (Sep 21, 2026).
//
// Owner: a 30-day build died on the planner's budget and the app told them to
// split it. Now the intake's day count decides the passes before the first
// request. This drives the built app at phone width with the planner mocked:
// the background transport is "unavailable" (so the streaming size, four days,
// applies), a ten-day trip is asked for, and the mock answers exactly the
// days each pass asks for. Asserted: three passes (1–4, 5–8, 9–10), each told
// where the last ended; the trip EXISTS after the first pass with four days;
// the status reads "Building days 5–8 of 10" with the pass bar under it while
// the second pass runs; the workspace opens on a ten-day trip at the end.
//
// Run: node tools/sims/build-passes-check.mjs   (RB_PORT overrides 5199)

import { chromium } from '../../node_modules/playwright-core/index.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const PORT = process.env.RB_PORT || '5199';
let pass = 0; let fail = 0;
const check = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`); ok ? pass++ : fail++; };

const concept = {
  id: 'loop-1', title: 'The big loop', summary: 'Ten days out and back',
  routeDescription: 'Out over the passes, back along the rivers.',
  why: 'Every day ends in a real town with fuel and a bed.',
  groupFit: 'Fuel inside range every day.', tradeoff: 'Long.',
  metrics: { miles: 2100, rideMinutes: 2900, dwellMinutes: 900, totalMinutes: 3800, arrival: null, longestFuelGap: 140, ascentFeet: 60000, deltaMiles: 0, deltaMinutes: 0, dayCount: 10, longestDayMiles: 260, longestDayMinutes: 420 },
  locations: [
    { name: 'Missoula', lat: 46.87, lng: -113.99, kind: 'start' },
    { name: 'Town Pump, Deer Lodge', lat: 46.39, lng: -112.73, kind: 'fuel', placeId: 'fuel-1' },
    { name: 'Bozeman', lat: 45.68, lng: -111.04, kind: 'lodging', placeId: 'stay-1' },
    { name: 'Missoula', lat: 46.87, lng: -113.99, kind: 'end' },
  ],
};

// The mock builds exactly the days a pass asks for; every day ends in a named
// town so the next pass can be checked for starting there.
const dayFor = (n) => ({
  title: `Day ${n}`, phase: n <= 5 ? 'outbound' : 'return', depart: '8:00 AM', summary: `Day ${n} of the loop.`,
  waypoints: [
    { name: `Stop ${n - 1} end`, lat: 45 + n * 0.1, lng: -110 - n * 0.1, kind: 'start' },
    { name: `Fuel ${n}`, lat: 45.05 + n * 0.1, lng: -110.05 - n * 0.1, kind: 'fuel', fuel: true, placeId: `fuel-${n}` },
    { name: `Stop ${n} end`, lat: 45.1 + n * 0.1, lng: -110.1 - n * 0.1, kind: 'end' },
  ],
  meals: [], lodging: { status: 'reserve', name: `Motel ${n}`, where: `Town ${n}` },
});

const generateCalls = [];
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.includes('/.netlify/functions/planner-background')) return route.fulfill({ status: 404, body: 'not available' });
  if (url.includes('/.netlify/functions/chat')) {
    const body = route.request().postDataJSON();
    let done;
    if (body.mode === 'explore') {
      done = { type: 'done', text: 'One loop, ten days, every night in a town.', concepts: [concept], recommendedId: 'loop-1', ms: 800 };
    } else {
      const r = body.dayRange ?? { from: 1, to: body.basics?.numDays ?? 1, total: body.basics?.numDays ?? 1 };
      generateCalls.push({ dayRange: body.dayRange ?? null, prior: body.priorDays ?? null, numDays: body.basics?.numDays });
      const days = [];
      for (let n = r.from; n <= r.to; n++) days.push(dayFor(n));
      done = { type: 'done', trip: { meta: { title: 'The Big Loop', summary: 'Ten days.', riders: 2 }, days }, verify: null, ms: 700, ...(body.dayRange ? { dayRange: body.dayRange } : {}) };
      // hold the second pass long enough to be looked at
      if (r.from === 5) await new Promise((res) => setTimeout(res, 2500));
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: `${JSON.stringify({ type: 'start', ms: 0 })}\n${JSON.stringify({ type: 'building', ms: 300, thinking: 40 })}\n${JSON.stringify(done)}\n`,
    });
  }
  if (url.includes(`127.0.0.1:${PORT}`)) return route.continue();
  return route.abort();
});

const activeTrip = () => page.evaluate(() => {
  try {
    const lib = JSON.parse(localStorage.getItem('moto.trips.v1') || '{}');
    const rec = (lib.trips ?? []).find((r) => r.id === lib.activeId);
    return rec ? { title: rec.trip?.meta?.title, days: (rec.trip?.days ?? []).map((d) => ({ title: d.title, date: d.date, first: d.waypoints?.[0]?.name, last: d.waypoints?.[d.waypoints.length - 1]?.name })) } : null;
  } catch { return null; }
});

await page.goto(`http://127.0.0.1:${PORT}/`);
const guest = page.locator('.land-skip');
if (await guest.isVisible().catch(() => false)) await guest.click();
await page.waitForSelector('.hm-pill', { timeout: 15000 });
await page.locator('.hm-pill').click();
await page.fill('.hm-input', 'Two riders, ten days, a big loop out of Missoula with a real bed every night.');
await page.waitForSelector('.hm-ai.lead', { timeout: 5000 });
await page.locator('.hm-ai').click();
await page.waitForSelector('.trip-builder');
const daysInput = page.locator('.builder-basics label.fld', { hasText: 'Days' }).locator('input');
await daysInput.fill('10');
check((await daysInput.inputValue()) === '10', 'the intake carries ten days');
await page.locator('.construction-composer .btn', { hasText: 'Explore the trip' }).click();
await page.waitForSelector('.concept-tabs button');
check(await page.locator('.concept-tabs button').count() === 1, 'one concept comes back to confirm');
check(await activeTrip().then((t) => t?.title !== 'The Big Loop'), 'nothing is created before Create this trip');

await page.locator('.construction-confirm .btn', { hasText: 'Create this trip' }).click();
// pass 2 is held open by the mock: look at the screen while it runs
const seenStatus = [];
const poll = setInterval(async () => {
  const t = await page.evaluate(() => document.querySelector('.msg.streaming .thinking')?.textContent ?? '').catch(() => '');
  if (t && seenStatus[seenStatus.length - 1] !== t) seenStatus.push(t);
}, 150);
let sawPass2 = true;
try {
  await page.waitForFunction(() => /Building days 5–8 of 10/.test(document.querySelector('.msg.streaming .thinking')?.textContent ?? ''), null, { timeout: 15000 });
} catch {
  sawPass2 = false;
  console.log('DIAG statuses:', JSON.stringify(seenStatus));
  console.log('DIAG generateCalls:', JSON.stringify(generateCalls));
  console.log('DIAG errors:', JSON.stringify(errors));
  console.log('DIAG error box:', await page.locator('.construction-error, .set-note.warn, .msg.error').allTextContents().catch(() => []));
  console.log('DIAG modebar visible:', await page.locator('.modebar').isVisible().catch(() => false), 'trip:', JSON.stringify(await activeTrip()));
}
clearInterval(poll);
check(sawPass2, 'the status names the pass being built: "Building days 5–8 of 10"');
const bar = page.locator('.msg.streaming .build-pass');
const barVisible = await bar.isVisible();
if (!barVisible) console.log('DIAG bar:', JSON.stringify(await bar.evaluate((el) => { const cs = getComputedStyle(el); const b = el.getBoundingClientRect(); return { display: cs.display, height: cs.height, width: cs.width, box: [b.x, b.y, b.width, b.height] }; }).catch((e) => String(e))));
check(barVisible, 'the pass bar is on screen under the status (the build brings the conversation pane forward on a phone)');
await page.screenshot({ path: new URL('./shots/build-passes-phone.png', import.meta.url).pathname });
check((await bar.getAttribute('aria-valuenow')) === '4' && (await bar.getAttribute('aria-valuemax')) === '10', 'the bar counts four of ten days built', `${await bar.getAttribute('aria-valuenow')}/${await bar.getAttribute('aria-valuemax')}`);
const solid = await bar.locator('i').evaluate((el) => Math.round(parseFloat(getComputedStyle(el).width)));
const sweep = await bar.locator('b').evaluate((el) => ({ w: Math.round(parseFloat(getComputedStyle(el).width)), anim: getComputedStyle(el).animationName }));
const barW = await bar.evaluate((el) => Math.round(parseFloat(getComputedStyle(el).width)));
check(Math.abs(solid - barW * 0.4) <= 2 && Math.abs(sweep.w - barW * 0.4) <= 2, 'the solid part is 40% (built) and the sweep covers the next 40% (this pass)', `solid ${solid} sweep ${sweep.w} of ${barW}`);
check(sweep.anim === 'build-sweep', 'the current pass moves (the sweep animation runs)', sweep.anim);
check(await page.locator('.msg.streaming .thinking').evaluate((el) => getComputedStyle(el, '::after').animationName) === 'builder-pulse', 'the pulsing dot on the status line still beats');
const mid = await activeTrip();
check(mid?.title === 'The Big Loop' && mid.days.length === 4, 'the trip already EXISTS after the first pass, with its four days', JSON.stringify(mid));
check(mid?.days?.[0]?.date === new Date().toISOString().slice(0, 10) || !!mid?.days?.[0]?.date, 'the first pass pinned dates');

await page.waitForSelector('.modebar', { timeout: 30000 });
const done = await activeTrip();
check(done?.days?.length === 10, 'the workspace opens on a ten-day trip', JSON.stringify(done?.days?.length));
check(done?.days?.map((d) => d.title).join(',') === Array.from({ length: 10 }, (_, i) => `Day ${i + 1}`).join(','), 'the days are in order with no repeats', done?.days?.map((d) => d.title).join(','));
const dates = done?.days?.map((d) => d.date) ?? [];
const consecutive = dates.every((d, i) => i === 0 || (Date.parse(d) - Date.parse(dates[i - 1])) === 86_400_000);
check(consecutive, 'appended days cascade their dates from the start date', dates.join(','));
check(done?.days?.[4]?.first === 'Stop 4 end', 'day 5 starts where day 4 ended');
check(generateCalls.length === 3, 'three passes for ten days on the streaming transport (4 + 4 + 2)', String(generateCalls.length));
check(generateCalls[0]?.dayRange?.from === 1 && generateCalls[0].dayRange.to === 4 && generateCalls[0].dayRange.total === 10 && generateCalls[0].prior?.length === 0, 'pass 1 asks for days 1–4 of 10 with nothing prior', JSON.stringify(generateCalls[0]));
check(generateCalls[1]?.dayRange?.from === 5 && generateCalls[1].dayRange.to === 8 && generateCalls[1].prior?.length === 4 && generateCalls[1].prior[3]?.to?.name === 'Stop 4 end', 'pass 2 asks for 5–8 and is told day 4 ended at "Stop 4 end"', JSON.stringify(generateCalls[1]?.prior?.[3]));
check(generateCalls[2]?.dayRange?.from === 9 && generateCalls[2].dayRange.to === 10 && generateCalls[2].prior?.length === 8, 'pass 3 asks for the last two days, told about eight', JSON.stringify(generateCalls[2]?.dayRange));
check(generateCalls.every((c) => c.numDays === 10), 'every pass still carries the whole trip\'s day count');
check(errors.length === 0, 'zero page errors', errors.join(' | '));

await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
