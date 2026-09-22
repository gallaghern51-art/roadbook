// An unfinished plan survives the app closing (Sep 20 2026).
//
// Owner: "...or save for later". A created trip already lives in the library
// and backs up to the account. This is the part before that: a rider who got
// three researched options, replaced a stop, and closed the app to decide
// tomorrow used to come back to an empty builder. Every step below crosses a
// real page reload.
//
//   npm run dev    # :5199 (RB_PORT overrides)
//   node tools/sims/builder-resume-check.mjs

import { chromium } from '../../node_modules/playwright-core/index.mjs';
// Answers Mapbox's style, tiles AND telemetry. Aborting telemetry instead races
// mapbox-gl's own teardown: a map removed before its map-load event fails calls
// `this.errorCb`, which remove() already nulled — a library error, not ours.
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';

const PORT = process.env.RB_PORT ?? '5199';
const BASE = `http://127.0.0.1:${PORT}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
let pass = 0; let fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (ok) pass++; else fail++; };

const option = {
  id: 'mountain-1', title: 'Passes + hot springs', summary: 'Best blend',
  routeDescription: 'US-550 over the passes.', why: 'Coherent day.', groupFit: 'Fine.', tradeoff: 'Weather.',
  searchPolyline: 'siobFrimqSkd_@cgN_db@_aM_od@kxKo`Vja@_cQvG',
  metrics: { depart: '06:45', miles: 238, rideMinutes: 326, dwellMinutes: 95, totalMinutes: 421, arrival: '14:06', longestFuelGap: 112, deltaMiles: 0, deltaMinutes: 0 },
  locations: [
    { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'start' },
    { name: 'Conoco, Ouray', lat: 38.02, lng: -107.67, kind: 'fuel', placeId: 'fuel-1', verified: 'google' },
    { name: 'Brickhouse 737', lat: 38.021, lng: -107.671, kind: 'food', placeId: 'food-1', verified: 'google' },
    { name: 'Montrose', lat: 38.47, lng: -107.87, kind: 'end' },
  ],
};
const FOOD_ROWS = [
  { id: 'g-maggies', source: 'google', name: "Maggie's Kitchen", detail: '520 Main St, Ouray', lat: 38.022, lng: -107.672, rating: 4.6, userRatingCount: 330, primaryType: 'restaurant', types: ['restaurant'], openNow: true, status: 'OPERATIONAL' },
];

let exploreCalls = 0;
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (routeMapbox(route)) return undefined;
  if (isMockTile(url)) return route.fulfill({ status: 204 });
  if (url.includes('/.netlify/functions/planner-background')) return route.fulfill({ status: 404, body: 'x' });
  if (url.includes('/.netlify/functions/nearby-places')) return route.fulfill({ json: FOOD_ROWS });
  if (url.includes('/.netlify/functions/evaluate-route')) {
    const c = route.request().postDataJSON().concepts[0];
    return route.fulfill({ json: { options: [{ id: c.id, title: c.title, locations: c.locations, searchPolyline: option.searchPolyline, metrics: { ...option.metrics, miles: 241 } }] } });
  }
  if (url.includes('/.netlify/functions/chat')) {
    const body = route.request().postDataJSON();
    if (body.mode === 'explore') exploreCalls++;
    const done = body.mode === 'explore'
      ? { type: 'done', text: 'Here is the option.', concepts: [option], recommendedId: option.id, ms: 700 }
      : { type: 'done', trip: { meta: {}, days: [] }, ms: 700 };
    return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'start', ms: 0 })}\n${JSON.stringify(done)}\n` });
  }
  if (url.startsWith(BASE)) return route.continue();
  return route.abort();
});

const home = async () => {
  await page.goto(`${BASE}/`);
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  // the app reopens on whichever screen it was left on — after creating a
  // trip that is the trip itself, so walk back to the home map as a rider does
  await page.waitForSelector('.hm-pill, .mast-back', { timeout: 15000 });
  if (await page.locator('.mast-back').isVisible().catch(() => false)) await page.locator('.mast-back').click();
  await page.waitForSelector('.hm-pill', { timeout: 15000 });
};
// the empty pill's standing row: the builder with NO new sentence
const openBuilderEmpty = async () => {
  await page.locator('.hm-pill').click();
  await page.locator('.hm-ai.lead').click();
  await page.waitForSelector('.trip-builder');
};
const openBuilderWith = async (sentence) => {
  await page.locator('.hm-pill').click();
  await page.fill('.hm-input', sentence);
  await page.waitForSelector('.hm-ai.lead', { timeout: 5000 });
  await page.locator('.hm-ai.lead').click();
  await page.waitForSelector('.trip-builder');
};

// ── 1. research, replace a stop, then the app closes ──
await home();
await page.evaluate(() => localStorage.removeItem('moto.builderSession.v1'));
await openBuilderWith('Durango to Montrose over the passes, one rider.');
await page.locator('.construction-composer .btn', { hasText: 'Explore the trip' }).click();
await page.waitForSelector('.concept-stops li');
await page.locator('.concept-stops li', { hasText: 'Brickhouse 737' }).getByRole('button', { name: 'Replace' }).click();
await page.waitForSelector('.concept-replace .nb-list .nb-item', { timeout: 8000 });
await page.locator('.concept-replace .nb-main', { hasText: "Maggie's Kitchen" }).click();
await page.locator('.concept-replace .nb-actions .btn', { hasText: 'Use this instead' }).click();
await page.waitForFunction(() => /241/.test(document.querySelector('.concept-facts')?.innerText ?? ''), null, { timeout: 8000 });
await page.waitForTimeout(700); // the save is debounced
const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('moto.builderSession.v1') || 'null'));
check(!!kept && kept.concepts?.length === 1, 'the plan is kept on the device as it changes');
check(kept?.concepts?.[0]?.locations?.some((l) => l.name === "Maggie's Kitchen"), '…including the stop the rider replaced');

// ── 2. come back: the builder with no new sentence picks it back up ──
await home(); // a real reload
await openBuilderEmpty();
await page.waitForSelector('.concept-stops li', { timeout: 8000 });
const restoredStops = await page.locator('.concept-stops li').allInnerTexts();
check(restoredStops.some((t) => t.includes("Maggie's Kitchen")), 'after a reload, the plan is back — with the replaced dinner');
check(!restoredStops.some((t) => t.includes('Brickhouse 737')), '…and not the dinner the rider took out');
check(/241/.test(await page.locator('.concept-facts').innerText()), 'with its re-measured figures, not the old ones');
check(exploreCalls === 1, `and no planner turn was spent bringing it back (${exploreCalls} explore calls total)`);
check((await page.locator('.construction-thread .msg').count()) >= 2, 'the conversation came back too');
const strip = await page.evaluate(() => {
  const btn = document.querySelector('.builder-context button')?.getBoundingClientRect();
  const hits = [...document.querySelectorAll('.builder-context span')].filter((sp) => {
    const b = sp.getBoundingClientRect();
    return b.right > btn.left + 1 && b.left < btn.right && b.bottom > btn.top && b.top < btn.bottom;
  });
  return { btn: !!btn, hits: hits.map((h) => h.textContent) };
});
check(strip.btn && strip.hits.length === 0, `the trip facts never run under Edit trip details (${strip.hits.join(', ') || 'clear'})`);
await page.screenshot({ path: new URL('./shots/builder-restored-phone.png', import.meta.url).pathname });

// ── 3. arrive with a NEW sentence: a fresh start, the old plan offered back ──
await home();
await openBuilderWith('A weekend loop out of Boulder, two riders.');
check(await page.locator('.builder-resume').isVisible(), 'a new sentence starts fresh — but offers the unfinished plan back');
await page.screenshot({ path: new URL('./shots/builder-resume-phone.png', import.meta.url).pathname });
// the offer sits in the conversation, under the trip frame — never on top of it
const resumeBox = await page.evaluate(() => {
  const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const frame = r('.builder-basics'); const offer = r('.builder-resume');
  return { frameBottom: Math.round(frame.bottom), offerTop: Math.round(offer.top) };
});
check(resumeBox.offerTop >= resumeBox.frameBottom, `the offer sits below the trip frame, not over Avoid tolls (frame ends ${resumeBox.frameBottom}, offer starts ${resumeBox.offerTop})`);
check(await page.locator('.concept-stops li').count() === 0, 'the old plan is not silently loaded over the new ride');
check((await page.locator('.construction-composer textarea').inputValue()).includes('Boulder'), 'the new sentence is what is in the box');
check(/1 route option/.test(await page.locator('.builder-resume').innerText()), 'the offer says what it is bringing back');
await page.locator('.builder-resume .btn', { hasText: 'Resume it' }).click();
await page.waitForSelector('.concept-stops li', { timeout: 5000 });
check((await page.locator('.concept-stops li').allInnerTexts()).some((t) => t.includes("Maggie's Kitchen")), 'Resume brings the old plan back, edits intact');
check(!(await page.locator('.builder-resume').isVisible().catch(() => false)), 'and the offer goes away');

// ── 4. start over clears it ──
await page.locator('.construction-mobile-nav button', { hasText: 'Conversation' }).click().catch(() => {});
await page.locator('.builder-startover').click();
check(await page.locator('.concept-stops li').count() === 0, 'Start over clears the plan off the screen');
check(await page.evaluate(() => localStorage.getItem('moto.builderSession.v1')) === null, '…and off the device');

// ── 5. creating the trip spends the kept plan ──
await home();
await openBuilderWith('Durango to Montrose over the passes, one rider.');
await page.locator('.construction-composer .btn', { hasText: 'Explore the trip' }).click();
await page.waitForSelector('.concept-stops li');
await page.waitForTimeout(700);
check(await page.evaluate(() => !!localStorage.getItem('moto.builderSession.v1')), 'a fresh plan is kept again');
await page.locator('.construction-confirm').scrollIntoViewIfNeeded();
await page.screenshot({ path: new URL('./shots/builder-confirm-phone.png', import.meta.url).pathname });
const bar = await page.evaluate(() => {
  const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
  const root = document.querySelector('.construction-confirm');
  const span = [...root.querySelectorAll('span')].find((x) => x.getBoundingClientRect().height > 0) ?? root.querySelector('span');
  const create = [...root.querySelectorAll('.btn')].find((b) => /Create this trip/.test(b.textContent));
  const writeup = root.querySelector('.construction-writeup');
  return { bar: box(root), span: box(span), create: box(create), writeup: box(writeup), overflow: root.scrollWidth > root.clientWidth };
});
check(bar.span.h > 0, 'on a phone the bar still says the trip can be edited after it is created');
check(bar.create.w >= bar.bar.w - 40, `Create this trip is the full-width primary (${Math.round(bar.create.w)} of ${Math.round(bar.bar.w)}px)`);
check(bar.writeup.t >= bar.create.b && bar.writeup.h >= 44, 'the planner write-up sits under it as a 44pt second choice');
check(!bar.overflow && bar.bar.h <= 140, `and the bar fits the phone without spilling (${Math.round(bar.bar.h)}px tall)`);
await page.locator('.construction-confirm .btn', { hasText: 'Create this trip' }).click();
await page.waitForSelector('.modebar', { timeout: 10000 });
await page.waitForTimeout(800); // longer than the save debounce: a queued save must not write it back
check(await page.evaluate(() => localStorage.getItem('moto.builderSession.v1')) === null,
  'once the trip is created the kept plan is gone — it IS the trip now, in the library');
await home();
await openBuilderEmpty();
check(await page.locator('.concept-stops li').count() === 0 && !(await page.locator('.builder-resume').isVisible().catch(() => false)),
  'so the builder opens clean next time, with nothing stale to resume');

check(errors.length === 0, `no page errors (${errors.join('; ') || 'none'})`);
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
