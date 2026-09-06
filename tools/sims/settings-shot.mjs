import { chromium } from '../../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.includes('localhost:5199')) return route.continue();
  return route.abort();
});
await page.goto('http://localhost:5199/');
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForTimeout(1500);
// ensure the overview panel is the open one
if (!(await page.locator('label:has-text("Group pace buffer")').count())) {
  await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(500);
  await page.locator('.rchip').nth(0).click();
  await page.waitForTimeout(800);
}
const fld = page.locator('label:has-text("Group pace buffer")');
await fld.waitFor({ timeout: 8000 });
await fld.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: './shots/ui-trip-settings.png' });
await browser.close();
console.log('ok');
