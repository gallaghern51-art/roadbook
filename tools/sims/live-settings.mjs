// LIVE settings check — real account, real geocoder, no mocked network.
//
// Covers the buildout end to end: the sections exist and switch, a home address
// is SEARCHED (not typed) so it carries real coordinates, a bike is resolved
// from the catalogue and sets the range the feasibility engine grades against,
// stated taste is captured, all of it survives a reload, and — the point of the
// whole thing — a new trip's planner payload carries the home coordinates so
// "start at home" is answerable.
//
//   RB_EMAIL=… RB_PASSWORD=… node tools/sims/live-settings.mjs
//
// Credentials come from the environment. The run writes to that account's real
// profile and puts it back the way it found it.
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

if (!process.env.RB_EMAIL || !process.env.RB_PASSWORD) {
  console.error('Set RB_EMAIL and RB_PASSWORD — this sim signs in to a real account.');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath, headless: false, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));

// Watch the geocoder: a saved place has to come from a real lookup.
let geocodeCalls = 0;
page.on('request', (r) => {
  if (/nominatim|google-places/.test(r.url())) geocodeCalls += 1;
});

const profile = () => page.evaluate(() => JSON.parse(localStorage.getItem('moto.profile.v1') || 'null'));
const openSettings = async () => {
  await page.locator('.mast .btn.icon[title="Settings"], button[aria-label="Settings"]').first().click();
  await page.waitForSelector('.panel-view.settings', { timeout: 10000 });
};
const tab = async (name) => {
  await page.locator('.set-tabs button', { hasText: new RegExp(`^${name}$`, 'i') }).click();
  await page.waitForTimeout(350);
};

await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="email"]', { timeout: 20000 });
await page.fill('input[type="email"]', process.env.RB_EMAIL);
await page.fill('input[type="password"]', process.env.RB_PASSWORD);
await page.click('button:has-text("Sign in")');
await page.waitForSelector('.trip-card', { timeout: 30000 });
await page.waitForTimeout(2000);
check(true, 'signed in to the real account');

// Remember what was there so this run leaves no trace.
const before = await profile();

await page.locator('.trip-card').first().click();
await page.waitForSelector('.modebar', { timeout: 20000 });
await page.waitForTimeout(1000);
await openSettings();

// ---- the sections exist ----------------------------------------------------
const tabs = await page.locator('.set-tabs button').allTextContents();
check(tabs.length >= 8, `settings is sectioned (${tabs.join(' · ')})`);
for (const want of ['Places', 'Riding', 'Map', 'Ride Mode', 'Data']) {
  check(tabs.some((x) => x.trim().toLowerCase() === want.toLowerCase()), `there is a ${want} section`);
}
const noHorizontalBleed = await page.evaluate(() => {
  const el = document.querySelector('.panel-view.settings');
  return el.scrollWidth <= el.clientWidth + 1;
});
check(noHorizontalBleed, 'settings does not bleed horizontally');

// ---- a home address, searched not typed ------------------------------------
await tab('Places');
check(await page.locator('.set-note.warn').count() === 1, 'it says there is no home address yet');
const geoBefore = geocodeCalls;
await page.locator('.sp-roles button', { hasText: 'Home' }).click();
await page.locator('.sp-add input').fill('1500 Harbor Blvd Weehawken NJ');
await page.waitForSelector('.sp-results button', { timeout: 20000 });
check(geocodeCalls > geoBefore, `the address went to a real geocoder (${geocodeCalls - geoBefore} lookup(s))`);
const firstHit = await page.locator('.sp-results button').first().innerText();
await page.locator('.sp-results button').first().click();
await page.waitForTimeout(700);

const withHome = await profile();
const home = withHome?.places?.find((p) => p.role === 'home');
check(!!home, `the home place is saved (${home?.label ?? 'none'})`);
check(Number.isFinite(home?.lat) && Number.isFinite(home?.lng),
  `it carries real coordinates (${home?.lat?.toFixed(4)}, ${home?.lng?.toFixed(4)})`);
check(Math.abs(home.lat - 40.77) < 0.2 && Math.abs(home.lng + 74.02) < 0.2,
  'the coordinates are actually Weehawken, not a same-named place elsewhere');
check(await page.locator('.set-note.warn').count() === 0, 'the "no home yet" warning clears');
await page.screenshot({ path: SHOT('settings-places') });

// ---- the bike catalogue sets the range -------------------------------------
await tab('Riding');
await page.locator('.bike-search input').fill('road glide');
await page.waitForTimeout(400);
const bikeHits = await page.locator('.sp-results button').allTextContents();
check(bikeHits.length > 0, `typing a model finds it (${bikeHits[0]?.split('\n')[0] ?? 'none'})`);
await page.locator('.sp-results button').first().click();
await page.waitForTimeout(600);

const withBike = await profile();
const bike = withBike?.riding?.bike;
check(bike?.model === 'Road Glide', `the bike is stored with its spec (${bike?.make} ${bike?.model}, ${bike?.tank} gal, ${bike?.mpg} mpg)`);
// 6.0 gal x 38 mpg = 228 absolute, 20% reserve = 182 comfort.
check(withBike.riding.rangeAbsolute === 228 && withBike.riding.rangeComfort === 182,
  `range is derived from tank x economy (${withBike.riding.rangeComfort}/${withBike.riding.rangeAbsolute} mi)`);
const shownRange = await page.evaluate(() => {
  const fields = [...document.querySelectorAll('.set-grid .fld')];
  const val = (label) => fields.find((f) => f.textContent.includes(label))?.querySelector('input')?.value;
  return { comfort: val('Comfortable'), absolute: val('Absolute') };
});
check(shownRange.comfort === '182' && shownRange.absolute === '228',
  `the derived range lands in the editable fields (${shownRange.comfort}/${shownRange.absolute})`);

// It must be an override, not a lock — an aux tank is in no catalogue.
await page.locator('.set-grid .fld', { hasText: 'Absolute range' }).locator('input').fill('300');
await page.waitForTimeout(600);
check((await profile())?.riding?.rangeAbsolute === 300, 'the rider can override the catalogue figure');
await page.locator('.set-grid .fld', { hasText: 'Absolute range' }).locator('input').fill('228');
await page.waitForTimeout(400);

// ---- stated taste ----------------------------------------------------------
const tagBox = (label) => page.locator('.tagfield', { hasText: label }).locator('.tag-add input');
await tagBox('Dietary needs').fill('vegetarian');
await tagBox('Dietary needs').press('Enter');
await tagBox('Avoid').fill('interstates, gravel');
await tagBox('Avoid').press('Enter');
await page.waitForTimeout(600);
const tasted = await profile();
check(tasted?.taste?.dietary?.includes('vegetarian'), `dietary needs are captured (${tasted?.taste?.dietary?.join(', ')})`);
check(tasted?.taste?.avoid?.length === 2, `a comma-separated entry becomes two tags (${tasted?.taste?.avoid?.join(' | ')})`);
// The first live run rendered this as one uppercase stripe reading
// "AVOID TOLLSKEEPS TOLLED BRIDGES..." with a loose square above it: `.fld`
// styles a label as a caption over a full-width control, which a checkbox is
// not. Assert the shape, not just the presence.
const checkShape = await page.evaluate(() => {
  const label = [...document.querySelectorAll('.fld.check')].find((l) => /Avoid tolls/i.test(l.textContent));
  if (!label) return null;
  const box = label.querySelector('input[type=checkbox]');
  const text = label.querySelector('span');
  const br = box.getBoundingClientRect();
  const tr = text.getBoundingClientRect();
  return {
    boxW: Math.round(br.width),
    sideBySide: br.right <= tr.left + 1,        // box beside the words, not above
    caption: getComputedStyle(label.querySelector('small')).textTransform,
    title: getComputedStyle(text).textTransform,
    hit: Math.round(label.getBoundingClientRect().height),
  };
});
check(!!checkShape, 'the avoid-tolls checkbox is on the riding section');
check(checkShape.boxW > 0 && checkShape.boxW <= 24, `the checkbox is a checkbox, not a stretched control (${checkShape.boxW}px)`);
check(checkShape.sideBySide, 'the box sits beside its label rather than above it');
check(checkShape.caption === 'none' && checkShape.title === 'none',
  `the label reads as a sentence, not an uppercase stripe (${checkShape.title}/${checkShape.caption})`);
check(checkShape.hit >= 44, `the whole label is a 44pt target (${checkShape.hit}px)`);

await page.screenshot({ path: SHOT('settings-riding') });

// ---- it survives a reload --------------------------------------------------
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.trip-card, .modebar', { timeout: 30000 });
await page.waitForTimeout(2500);
const reloaded = await profile();
check(reloaded?.places?.some((p) => p.role === 'home'), 'the home place survives a reload');
check(reloaded?.riding?.bike?.model === 'Road Glide', 'the bike survives a reload');
check(reloaded?.taste?.dietary?.includes('vegetarian'), 'stated taste survives a reload');

// ---- and reaches the planner ----------------------------------------------
// The whole point: a new trip's payload must carry the home coordinates, or
// "start at home" is still a guess.
let plannerBody = null;
await page.route('**/planner-background**', async (route) => {
  try { plannerBody = route.request().postDataJSON(); } catch { /* not json */ }
  await route.fulfill({ status: 202, body: '' });
});
await page.route('**/planner-status**', (route) => route.fulfill({
  json: { status: 'error', message: 'stopped by the check — the payload is what matters here' },
}));

// The reload lands in the trip workspace; the AI intake lives on Home.
const back = page.locator('.mast-back');
if (await back.count()) { await back.first().click(); }
await page.waitForSelector('.trip-card', { timeout: 20000 });
await page.waitForTimeout(800);

await page.locator('textarea').first().fill('One day from home through upstate New York and back.');
await page.locator('button', { hasText: 'Plan with AI' }).first().click();
await page.waitForSelector('.construction-chat', { timeout: 20000 });
await page.waitForTimeout(800);
const explore = page.locator('button', { hasText: 'Explore the trip' });
if (await explore.count()) await explore.first().click();
await page.waitForTimeout(5000);

check(!!plannerBody, 'the builder sent a planning request');
const basics = plannerBody?.basics ?? {};
check(Array.isArray(basics.savedPlaces) && basics.savedPlaces.some((p) => p.role === 'home'),
  `the payload carries the saved home place (${basics.savedPlaces?.map((p) => p.role).join(', ') || 'none'})`);
const sentHome = basics.savedPlaces?.find((p) => p.role === 'home');
check(Math.abs((sentHome?.lat ?? 0) - home.lat) < 0.001 && Math.abs((sentHome?.lng ?? 0) - home.lng) < 0.001,
  'with the exact coordinates the geocoder returned');
check(basics.riderTaste?.dietary?.includes('vegetarian'),
  `and the stated dietary requirement (${JSON.stringify(basics.riderTaste?.dietary)})`);
check(basics.range?.absolute === 228 && basics.range?.comfort === 182,
  `and the bike's range (${basics.range?.comfort}/${basics.range?.absolute})`);
check(basics.routePrefs?.style === reloaded.riding.style,
  `and the road style (${basics.routePrefs?.style})`);

// ---- put the account back the way it was -----------------------------------
await page.evaluate((restore) => {
  if (restore) localStorage.setItem('moto.profile.v1', JSON.stringify({ ...restore, updatedAt: new Date().toISOString() }));
  else localStorage.removeItem('moto.profile.v1');
}, before);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const after = await profile();
check(JSON.stringify(after?.places ?? []) === JSON.stringify(before?.places ?? []),
  'the account profile was restored to what it was before the run');

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`   first geocoder hit was: ${firstHit.replace(/\n/g, ' · ')}`);
await browser.close();
process.exit(fail ? 1 : 0);
