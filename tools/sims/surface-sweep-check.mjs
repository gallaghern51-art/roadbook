// Every surface renders, and nothing blanks the app.
//
// This exists because a one-word mistake shipped and blanked the whole app.
// `profile` was added to the wrong component's useTrip() destructure in
// PrepBoard, so opening PREP threw a ReferenceError — and React, with no error
// boundary above it, unmounted the ENTIRE tree. Plan, Prep, Ride and Settings
// all went black together, on a phone, with no way back but a force quit.
//
// Not one of the existing sims opened PREP. They each drove the feature they
// were written for, which is how a crash on a screen nobody's test visited
// reached production. So this one visits every surface and asserts two things
// per stop: the app still has content, and nothing threw.
//
// It is deliberately shallow and wide. Depth belongs in the feature sims;
// this is the one that notices a whole screen is gone.
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`${e.message} — ${String(e.stack ?? '').split('\n')[1]?.trim() ?? ''}`));

// Defaults to the dev server; point it at a deploy with BASE_URL to check what
// riders are actually running.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5199';
if (!process.env.BASE_URL) {
  await page.route('**/*', (r) => (r.request().url().includes('5199') ? r.continue() : r.abort()));
}
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const guest = page.locator('.land-skip');
if (await guest.isVisible().catch(() => false)) await guest.click();
await page.waitForSelector('.trip-card', { timeout: 20000 });

// "Blank" is the failure this exists to catch, and it is measurable: a crashed
// tree leaves #root with no text at all, and the boundary leaves its own.
const surfaceOk = async (label) => {
  const state = await page.evaluate(() => ({
    text: document.querySelector('#root')?.innerText?.trim().length ?? 0,
    crashed: !!document.querySelector('.crash-screen'),
  }));
  check(state.text > 40 && !state.crashed,
    `${label} renders (${state.text} chars${state.crashed ? ', CRASH SCREEN' : ''})`);
  return state;
};

await surfaceOk('Home');

await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 20000 });
await page.waitForTimeout(3000);
await surfaceOk('Trip / Plan');

// Every mode seat.
for (const seat of ['PREP', 'PLAN']) {
  await page.locator('.modebar button', { hasText: seat }).first().click();
  await page.waitForTimeout(1200);
  await surfaceOk(`Mode: ${seat}`);
}

// Every PREP focus view — each is its own panel and each can fail alone.
await page.locator('.modebar button', { hasText: 'PREP' }).first().click();
await page.waitForTimeout(1000);
const cards = await page.locator('.dash-card').count();
check(cards > 0, `PREP offers its status cards (${cards})`);
for (let i = 0; i < Math.min(cards, 8); i += 1) {
  const card = page.locator('.dash-card').nth(i);
  const label = (await card.innerText().catch(() => '')).split('\n')[0]?.trim().slice(0, 24) || `card ${i}`;
  await card.click().catch(() => {});
  await page.waitForTimeout(900);
  await surfaceOk(`PREP → ${label}`);
  // Back to the board for the next card, however this focus view closes.
  await page.locator('button', { hasText: /^(‹|←|Back|✕)/ }).first().click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(500);
  if (!(await page.locator('.dash-card').count())) {
    await page.locator('.modebar button', { hasText: 'PREP' }).first().click().catch(() => {});
    await page.waitForTimeout(900);
  }
}

// Every settings section — the buildout added nine of them at once.
await page.locator('button[aria-label="Settings"], .btn.icon[title="Settings"]').first().click();
await page.waitForSelector('.set-tabs', { timeout: 10000 });
const tabs = await page.locator('.set-tabs button').allTextContents();
check(tabs.length >= 8, `Settings has its sections (${tabs.length})`);
for (const name of tabs) {
  await page.locator('.set-tabs button', { hasText: new RegExp(`^${name.trim()}$`, 'i') }).first().click();
  await page.waitForTimeout(600);
  await surfaceOk(`Settings → ${name.trim()}`);
}

// The Copilot dock and the day panel, the two overlays a rider opens most.
await page.keyboard.press('Escape').catch(() => {});
await page.locator('.modebar button', { hasText: 'PLAN' }).first().click().catch(() => {});
await page.waitForTimeout(900);
await page.locator('.dock-fab').first().click({ timeout: 4000 }).catch(() => {});
await page.waitForTimeout(1000);
await surfaceOk('Copilot dock');
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(600);

check(errors.length === 0, `no uncaught errors across every surface (${errors.slice(0, 2).join(' | ') || 'none'})`);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
