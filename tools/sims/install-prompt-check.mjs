// The Home-Screen install prompt: shown in a browser tab, never in the
// installed app, teaches the right buttons per browser, and stays away for a
// fortnight once dismissed.
//
//   npm run dev    # :5199
//   node tools/sims/install-prompt-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CRIOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.108 Mobile/15E148 Safari/604.1';

async function open({ ua, standalone = false, label }) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, userAgent: ua, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/*', (r) => (r.request().url().includes('localhost:5199') ? r.continue() : r.abort()));
  if (standalone) {
    // what an installed web clip reports
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (q.includes('display-mode: standalone') ? { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q));
    });
  }
  await page.goto('http://localhost:5199/');
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.home', { timeout: 15000 });
  await page.waitForTimeout(400);
  console.log(`\n── ${label} ──`);
  return { ctx, page };
}

// 1. iPhone Safari, in a tab → the Share-button steps
{
  const { ctx, page } = await open({ ua: SAFARI, label: 'iPhone Safari tab' });
  const card = page.locator('.install-card');
  check(await card.count() === 1, 'install card shows in a browser tab');
  const steps = await page.locator('.install-steps li').allTextContents();
  check(steps.length === 3 && /Share button/.test(steps[0]) && /Add to Home Screen/.test(steps[1]),
    `Safari steps name the Share button, then Add to Home Screen (${steps.length} steps)`);
  const box = await card.boundingBox();
  check(box && box.x >= 12 && box.x + box.width <= 375 - 12, `card sits inside the phone on the home screen's own gutter (x ${Math.round(box.x)}, w ${Math.round(box.width)})`);
  const x = await page.locator('.install-x').boundingBox();
  check(x && x.width >= 44 && x.height >= 44, `dismiss is glove-sized (${Math.round(x.width)}×${Math.round(x.height)})`);
  await page.screenshot({ path: SHOT('install-prompt-safari') });
  // dismiss → gone, and snoozed
  await page.locator('.install-x').click();
  await page.waitForTimeout(200);
  check(await card.count() === 0, 'Not now hides the card');
  await page.reload();
  await page.waitForSelector('.home', { timeout: 15000 });
  await page.waitForTimeout(300);
  check(await page.locator('.install-card').count() === 0, 'and it stays hidden on the next visit (snoozed)');
  const snooze = await page.evaluate(() => Number(localStorage.getItem('moto.installSnooze.v1') || 0) - Date.now());
  check(snooze > 13 * 24 * 3600 * 1000, `snooze is about a fortnight (${Math.round(snooze / 86400000)} days)`);
  await ctx.close();
}

// 2. iPhone Chrome → the ⋯ menu steps
{
  const { ctx, page } = await open({ ua: CRIOS, label: 'iPhone Chrome tab' });
  const steps = await page.locator('.install-steps li').allTextContents();
  check(steps.length === 3 && /⋯ menu/.test(steps[0]) && /Share/.test(steps[1]) && /Add to Home Screen/.test(steps[1]),
    'Chrome-on-iPhone steps go through the ⋯ menu, then Share, then Add to Home Screen');
  await page.screenshot({ path: SHOT('install-prompt-chrome-ios') });
  await ctx.close();
}

// 3. installed (standalone) → never shown
{
  const { ctx, page } = await open({ ua: SAFARI, standalone: true, label: 'installed web clip' });
  check(await page.locator('.install-card').count() === 0, 'the installed app never sees the prompt');
  await ctx.close();
}

await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
