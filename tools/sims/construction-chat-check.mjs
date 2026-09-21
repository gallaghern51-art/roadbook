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
    // the evaluator writes the road's shape onto every option (precision-5);
    // the replace search reads it to look ALONG the proposed road
    searchPolyline: 'siobFrimqSkd_@cgN_db@_aM_od@kxKo`Vja@_cQvG',
    routeDescription: 'US-550 over the San Juan passes, then a verified hot-springs stay that sets up the next morning.',
    why: 'The signature road, lunch and overnight form one coherent day instead of three unrelated pins.',
    groupFit: 'Fuel is inside the comfort range and the long meal stop works for four bikes.',
    tradeoff: 'Adds mountain weather exposure and 48 minutes over the quickest choice.',
    metrics: { depart: '06:45', miles: 238, rideMinutes: 326, dwellMinutes: 95, totalMinutes: 421, arrival: '15:01', longestFuelGap: 112, ascentFeet: 8100, deltaMiles: 27, deltaMinutes: 48 },
    locations: [
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'start' },
      { name: revision === 1 ? 'Million Dollar Highway' : 'Coal Bank Pass', lat: 37.9, lng: -107.67, kind: 'road', detail: 'US-550' },
      { name: 'Conoco, Ouray', lat: 38.02, lng: -107.67, kind: 'fuel', placeId: 'fuel-1', detail: 'Verified on the route' },
      { name: 'Brickhouse 737', lat: 38.02, lng: -107.67, kind: 'food', placeId: 'food-1', detail: '737 Main St, Ouray, CO', rating: 4.7, userRatingCount: 842, priceLevel: 'PRICE_LEVEL_MODERATE', googleMapsUri: 'https://maps.google.com/brickhouse', websiteUri: 'https://example.com/brickhouse', phone: '(970) 555-0137', hours: ['Monday: 11:00 AM–9:00 PM', 'Tuesday: 11:00 AM–9:00 PM'], preferenceTags: ['new American', 'date-night'] },
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
const evalCalls = [];
let lastGenerate = null;
const FOOD_ROWS = [
  { id: 'g-ouray-grill', source: 'google', name: 'Ouray Main Street Grill', detail: '510 Main St, Ouray, CO', lat: 38.021, lng: -107.671, rating: 4.4, userRatingCount: 612, priceLevel: 'PRICE_LEVEL_MODERATE', primaryType: 'american_restaurant', types: ['restaurant'], openNow: true, status: 'OPERATIONAL' },
  { id: 'g-maggies', source: 'google', name: "Maggie's Kitchen", detail: '520 Main St, Ouray, CO', lat: 38.022, lng: -107.672, rating: 4.6, userRatingCount: 330, priceLevel: 'PRICE_LEVEL_INEXPENSIVE', primaryType: 'hamburger_restaurant', types: ['restaurant'], openNow: true, status: 'OPERATIONAL' },
];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.includes('/.netlify/functions/planner-background')) return route.fulfill({ status: 404, body: 'not available' });
  if (url.includes('/.netlify/functions/nearby-places')) return route.fulfill({ json: FOOD_ROWS });
  if (url.includes('/.netlify/functions/evaluate-route')) {
    const body = route.request().postDataJSON();
    evalCalls.push(body);
    const c = body.concepts[0];
    // the replacement costs a little: the re-measure must show NEW figures
    return route.fulfill({ json: { options: [{ id: c.id, title: c.title, locations: c.locations, searchPolyline: '_p~iF~ps|U', metrics: { depart: body.depart ?? '08:00', miles: 241, rideMinutes: 331, dwellMinutes: 95, totalMinutes: 426, arrival: '15:06', longestFuelGap: 112, ascentFeet: 8100 } }], baselineId: c.id } });
  }
  if (url.includes('/.netlify/functions/chat')) {
    const body = route.request().postDataJSON();
    let done;
    if (body.mode === 'explore') {
      exploreCalls++;
      done = { type: 'done', text: exploreCalls === 1 ? 'I found three ways to make the San Juans work. The first is the strongest overall blend.' : 'I replaced that road piece and rechecked the comparison.', concepts: options(exploreCalls), recommendedId: `mountain-${exploreCalls}`, ms: 1200 };
    } else {
      generateCalls++;
      lastGenerate = body;
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
// the home is the map now: the pill is both doors — a sentence leads with the AI row
await page.waitForSelector('.hm-pill', { timeout: 15000 });
await page.locator('.hm-pill').click();
await page.fill('.hm-input', 'Four riders, six days in the San Juans. Great roads, reliable fuel, one hot-springs night and memorable local food.');
await page.waitForSelector('.hm-ai.lead', { timeout: 5000 });
await page.locator('.hm-ai').click();
await page.waitForSelector('.trip-builder');
check(await page.locator('.construction-chat').isVisible(), 'AI opens as a construction conversation');
const fullScreen = await page.locator('.trip-builder').evaluate((el) => {
  const box = el.getBoundingClientRect();
  return box.top === 0 && box.left === 0 && Math.abs(box.width - innerWidth) <= 1 && Math.abs(box.height - innerHeight) <= 1;
});
check(fullScreen, 'AI builder owns the full screen instead of compressing into a modal');
check(await page.locator('.builder-basics').isVisible(), 'fixed trip inputs have a distinct intake stage');
check((await page.locator('.construction-composer textarea').inputValue()).includes('Four riders'), 'home prompt carries into the conversation');
await page.screenshot({ path: SHOT('construction-intake-phone'), fullPage: true });
await page.locator('.construction-composer .btn', { hasText: 'Explore the trip' }).click();
await page.waitForSelector('.concept-tabs button');
check(await page.locator('.construction-mobile-nav button.active', { hasText: 'Route plan' }).isVisible(), 'phone moves from conversation to a dedicated route-plan view when options arrive');
check(await page.locator('.concept-tabs button').count() === 3, 'planner presents three selectable route options');
check((await page.locator('.concept-facts').innerText()).includes('max fuel gap'), 'selected option exposes measured route and fuel facts');
check(await page.locator('.concept-stops li').count() >= 5, 'selected option exposes its ordered road and stop pieces');
check(await page.locator('.concept-stops .stop-verified').count() >= 2, 'verified opportunity stops are visibly distinguished');
const glanceRow = page.locator('.concept-stop', { hasText: 'Brickhouse 737' }).locator('.place-glance-row');
check(await glanceRow.isVisible() && (await glanceRow.innerText()).includes('4.7 ★') && (await glanceRow.innerText()).includes('$$'), 'verified food, lodging, and experiences show a rating/price glance on the row');
await glanceRow.locator('.place-details-btn').click();
await page.waitForSelector('.place-sheet', { timeout: 5000 });
const sheetText = await page.locator('.place-sheet').innerText();
check(sheetText.includes('Brickhouse 737') && sheetText.includes('★ 4.7') && sheetText.includes('737 Main St') && sheetText.includes('(970) 555-0137')
  && await page.locator('.place-sheet .ps-contact a[href="https://example.com/brickhouse"]').count() === 1, "Details opens Roadbook's own place sheet with rating, address, phone and website");
check(await page.locator('.place-sheet a[href*="maps.google.com"]').count() === 0 && !/Google Maps/.test(sheetText), 'the sheet never links out to Google Maps');
check(/Place facts from Google/i.test(sheetText), 'Google place content carries visible attribution');
{
  const foot = await page.locator('.place-sheet .ps-foot').innerText();
  check(/Replace this stop/.test(foot), "an intermediate stop's sheet offers Replace this stop — directly, no planner turn");
  check(/Ask the planner/.test(foot), '…and still offers the planner, as the second choice');
}
await page.locator('.place-sheet .ps-head .btn').click();
check(await page.locator('.place-sheet').count() === 0, 'the sheet closes');
check(await page.locator('.construction-confirm').getByText('Nothing is created yet.').isVisible(), 'trip stays uncommitted while the rider refines it');
check(!await page.locator('.builder-basics').isVisible() && await page.locator('.builder-context').isVisible(), 'trip inputs collapse to a compact summary once construction starts');
await page.getByText('Edit trip details', { exact: true }).click();
check(await page.locator('.builder-basics').isVisible() && await page.getByText('Done', { exact: true }).isVisible(), 'collapsed trip details remain editable on demand');
await page.getByText('Done', { exact: true }).click();
const messageCount = await page.locator('.construction-thread .msg').count();
const selectedBeforeTabs = await page.locator('.concept-tabs button.active').textContent();
await page.locator('.construction-mobile-nav button', { hasText: 'Conversation' }).click();
await page.fill('.construction-composer textarea', 'Keep the lunch, but reconsider the hotel.');
await page.locator('.tabbar button', { hasText: 'Blank' }).click();
await page.locator('.tabbar button', { hasText: 'AI builder' }).click();
const tabsPreserved = await page.locator('.concept-tabs button').count() === 3
  && await page.locator('.construction-thread .msg').count() === messageCount
  && (await page.locator('.concept-tabs button.active').textContent()) === selectedBeforeTabs
  && (await page.locator('.construction-composer textarea').inputValue()).includes('reconsider the hotel');
check(tabsPreserved, 'tab switches preserve the conversation, options, selection, and unsent draft');
await page.fill('.construction-composer textarea', '');
await page.locator('.construction-mobile-nav button', { hasText: 'Route plan' }).click();
const phoneFits = await page.locator('.trip-builder').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
check(phoneFits, 'construction workbench fits a phone without horizontal clipping');
await page.screenshot({ path: SHOT('construction-chat-phone'), fullPage: true });

// ── Replace a proposed stop by hand (owner, Sep 20 2026: "if you recommend
// one dinner spot and they dont want to go there. they should be able to
// choose replace and then ... search area for food" — "i dont want to force
// people into lengthy full AI rebuilds") ──
{
  const exploreBefore = exploreCalls;
  const factsBefore = await page.locator('.concept-facts').innerText();
  await page.locator('.concept-stops li', { hasText: 'Brickhouse 737' }).getByRole('button', { name: 'Replace' }).click();
  await page.waitForSelector('.concept-replace .nearby-tiles', { timeout: 5000 });
  check(true, 'Replace opens a search right there — no chat, no planner turn');
  const picker = await page.evaluate(() => ({
    title: document.querySelector('.concept-replace .nb-title b')?.textContent,
    active: document.querySelector('.concept-replace .nb-tile.active span')?.textContent,
    field: !!document.querySelector('.concept-replace .nb-q'),
    fieldPx: parseFloat(getComputedStyle(document.querySelector('.concept-replace .nb-q')).fontSize),
    alongRoute: !!document.querySelector('.concept-replace .nb-scope button'),
    askAI: !!document.querySelector('.concept-replace-ai'),
    // the property that matters is FITTING, not spanning: an earlier version
    // checked "at least as wide as the detail" and passed with the picker at
    // 980px on a 375px screen
    fits: document.querySelector('.concept-replace').getBoundingClientRect().right <= innerWidth + 1,
    tilesOnScreen: [...document.querySelectorAll('.concept-replace .nb-tile')].every((t) => t.getBoundingClientRect().right <= innerWidth + 1),
    tileCount: document.querySelectorAll('.concept-replace .nb-tile').length,
    twoUp: new Set([...document.querySelectorAll('.concept-replace .nb-tile')].map((t) => Math.round(t.getBoundingClientRect().left))).size === 2,
  }));
  check(/Replace Brickhouse 737/.test(picker.title ?? ''), `the search names the stop it replaces (${picker.title})`);
  check(/Food/i.test(picker.active ?? ''), `a dinner opens on Food — the stop's own role (${picker.active})`);
  check(picker.field && picker.fieldPx >= 16, `a search field for a name or a town, 16px so a phone does not zoom (${picker.fieldPx})`);
  check(picker.alongRoute, 'it can search along the proposed road, not just near the old pin');
  check(picker.askAI, 'the planner is still one tap away, for when the rider wants it to reason');
  check(picker.fits, 'the search fits the phone — nothing runs off the right edge');
  check(picker.tilesOnScreen && picker.tileCount === 7, `every category tile is on screen (${picker.tileCount})`);
  check(picker.twoUp, 'the tiles sit two to a row, as they do everywhere else on a phone');

  await page.waitForSelector('.concept-replace .nb-list .nb-item', { timeout: 8000 });
  await page.locator('.concept-replace').scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOT('concept-replace-phone') });
  await page.locator('.concept-replace .nb-main', { hasText: "Maggie's Kitchen" }).click();
  await page.locator('.concept-replace .nb-actions .btn', { hasText: 'Use this instead' }).click();

  await page.waitForFunction(() => !document.querySelector('.concept-replace'), null, { timeout: 5000 });
  const row = page.locator('.concept-stops li', { hasText: "Maggie's Kitchen" });
  check(await row.count() === 1, 'the dinner is now the place the rider picked');
  check(await page.locator('.concept-stops li', { hasText: 'Brickhouse 737' }).count() === 0, 'the old dinner is gone from the route');
  check(await row.locator('.stop-verified').count() === 1, 'the replacement arrives verified — it came from a live listing');
  const kindText = await row.locator('.stop-kind').innerText();
  check(/Food/i.test(kindText), `it is still the Food stop, in the same place in the order (${kindText})`);
  const order = await page.evaluate(() => [...document.querySelectorAll('.concept-stops .concept-stop .stop-copy b')].map((b) => b.textContent.replace(' ✓', '').trim()));
  check(order.indexOf("Maggie's Kitchen") === order.indexOf('Conoco, Ouray') + 1, `route order kept (${order.join(' → ')})`);

  await page.waitForFunction(() => /241/.test(document.querySelector('.concept-facts')?.innerText ?? ''), null, { timeout: 8000 });
  const factsAfter = await page.locator('.concept-facts').innerText();
  check(factsAfter !== factsBefore && /241/.test(factsAfter), `the route is re-measured with the new stop (${factsAfter.split('\n')[0]})`);
  check(evalCalls.length === 1, `re-measured by the model-free evaluator, once (${evalCalls.length})`);
  check(exploreCalls === exploreBefore, `and NO planner turn was spent (${exploreCalls - exploreBefore} extra)`);
  check(evalCalls[0].concepts.length === 1 && evalCalls[0].concepts[0].locations.some((l) => l.name === "Maggie's Kitchen"),
    'only the option that changed was sent, with the replacement in it');
  check(evalCalls[0].depart === '06:45', `re-measured from the ORIGINAL departure, so the arrival moves only if the road did (${evalCalls[0].depart})`);

  await page.locator('.concept-edited').scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: SHOT('concept-replaced-phone') });
  const edited = await page.locator('.concept-edited').innerText().catch(() => '');
  check(/Brickhouse 737 with Maggie's Kitchen/.test(edited), 'the rider is told the planner\'s notes were written for the original stops');

  // the "vs quickest" comparison is redone across all three options
  await page.locator('.concept-tabs button', { hasText: 'Canyons + local food' }).click();
  await page.locator('.concept-tabs button', { hasText: 'Passes + hot springs' }).click();
  check(/\+30 mi/.test(await page.locator('.concept-facts').innerText()),
    'the comparison with the quickest option is recomputed across the set (241 − 211 = +30 mi)');
}

// the planner path still works, when the rider wants it
await page.locator('.concept-stops li', { hasText: 'Million Dollar Highway' }).getByRole('button', { name: 'Replace' }).click();
await page.waitForSelector('.concept-replace-ai', { timeout: 5000 });
await page.locator('.concept-replace-ai').click();
check((await page.locator('.construction-composer textarea').inputValue()).includes('Replace Million Dollar Highway'), '"ask the planner" becomes a precise follow-up prompt');
await page.locator('.construction-composer .btn', { hasText: 'Send' }).click();
await page.getByText('Coal Bank Pass', { exact: true }).waitFor();
check(exploreCalls === 2, 'asking the planner runs a fresh research/evaluation turn — only when the rider chooses to');
await page.locator('.concept-tabs button', { hasText: 'Canyons + local food' }).click();
check((await page.locator('.concept-selected').innerText()).includes('Unaweep Canyon'), 'rider can select a different assembled option');

await page.setViewportSize({ width: 1366, height: 900 });
await page.waitForTimeout(250);
check(await page.locator('.construction-dialogue').isVisible() && await page.locator('.construction-plan').isVisible(), 'desktop keeps conversation and route plan visible side by side');
const desktopFits = await page.locator('.trip-builder').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
check(desktopFits, 'construction workbench fits desktop without clipping');
await page.screenshot({ path: SHOT('construction-chat-desktop') });

// Replace a stop on the option the rider is about to create. Its prose still
// names the old place, and the generator is told to "preserve stated
// tradeoffs" — so it must also be told the rider's edit is final, or it can put
// the removed place straight back.
await page.locator('.concept-stops li', { hasText: 'Gateway Canyons Grill' }).getByRole('button', { name: 'Replace' }).click();
await page.waitForSelector('.concept-replace .nb-list .nb-item', { timeout: 8000 });
await page.locator('.concept-replace .nb-main', { hasText: 'Ouray Main Street Grill' }).click();
await page.locator('.concept-replace .nb-actions .btn', { hasText: 'Use this instead' }).click();
const createBtn = page.locator('.construction-confirm .btn.gold');
check(/Re-measuring|Create this trip/.test(await createBtn.innerText()), 'Create waits while the route is re-measured');
await page.waitForFunction(() => /Create this trip/.test(document.querySelector('.construction-confirm .btn.gold')?.textContent ?? ''), null, { timeout: 8000 });

// two ways to create: now, or have the planner write it up
const confirmText = await page.locator('.construction-confirm').innerText();
check(/Create this trip/.test(confirmText) && /Have the planner write it up/.test(confirmText),
  'the rider chooses: create it now, or have the planner write it up');
check(/reorder, add or remove stops/.test(confirmText), 'and is told what they can do with it once it exists');

// this run takes the planner's write-up, to prove the edit survives THAT door;
// the instant door has its own sim (concept-instant-create-check)
await page.locator('.construction-confirm .btn', { hasText: 'Have the planner write it up' }).click();
await page.waitForSelector('.modebar', { timeout: 10000 });
check(generateCalls === 1, 'the planner\'s write-up runs only when the rider asks for it');
const genPrompt = lastGenerate?.prompt ?? '';
check(/"Gateway Canyons Grill" was replaced with "Ouray Main Street Grill"/.test(genPrompt),
  'the generator is told the rider replaced that stop');
check(/their choice is final/.test(genPrompt) && /do not restore it/.test(genPrompt),
  '…and that the choice is final, so it cannot put the old place back');
check(/Ouray Main Street Grill/.test(genPrompt.split('\n\n').slice(-1)[0] ?? ''),
  'the replacement is in the plan it builds from');
check((await page.locator('.brand').innerText()).includes('ROADBOOK'), 'confirmed plan lands in the trip workspace');
check(errors.length === 0, `no browser errors (${errors.join('; ') || 'none'})`);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
