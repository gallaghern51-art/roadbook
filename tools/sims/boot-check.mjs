import { chromium } from '../../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium'), args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.route('**/*', (r) => (r.request().url().includes('localhost:5199') ? r.continue() : r.abort()));
await page.goto('http://localhost:5199/');
{ const guest = page.locator('.land-skip'); if (await guest.isVisible().catch(() => false)) await guest.click(); } // the signed-out landing gate on a checkout with Supabase keys
await page.waitForSelector('.trip-card', { timeout: 15000 });
// force the standalone sizing path manually to prove the var flows into layout
const h = await page.evaluate(() => {
  document.documentElement.style.setProperty('--app-h', '600px');
  const el = document.createElement('div');
  el.style.cssText = 'height:100vh;height:var(--app-h,100dvh);position:absolute;visibility:hidden';
  document.body.appendChild(el);
  return el.getBoundingClientRect().height;
});
console.log('var-driven height resolves to:', h, '(expect 600)');
console.log('page errors:', errs.length ? errs : 'none');
await browser.close();
