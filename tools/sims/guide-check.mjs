// The how-to guide: doors, chapter switching, search, the video slot's
// graceful degradation, the #help deep link, and fit at phone width.
//
//   npm run dev    # :5199
//   node tools/sims/guide-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

const fits = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.scrollWidth - el.clientWidth <= 1 : null;
}, sel);

async function run(width, label) {
  console.log(`\n── ${label} (${width}px) ──`);
  const page = await browser.newPage({ viewport: { width, height: 820 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  // Everything off-localhost is aborted, guide videos included — which is also
  // the un-recorded case the placeholder exists for.
  await page.route('**/*', (r) => (r.request().url().includes('localhost:5199') ? r.continue() : r.abort()));
  await page.goto('http://localhost:5199/');
  await page.waitForSelector('.trip-card', { timeout: 20000 });

  // 1. the home screen has a door
  check(await page.locator('.trip-card.guide-card').count() === 1, 'home screen carries a How-to card');
  await page.locator('.trip-card.guide-card').click();
  await page.waitForSelector('.guide-modal', { timeout: 8000 });
  check(true, 'the card opens the guide');

  // 2. chapters render written steps
  const chapters = await page.locator('.guide-chap').count();
  check(chapters >= 10, `chapter rail lists the guide (${chapters} chapters)`);
  const steps = await page.locator('.guide-steps li').count();
  check(steps >= 3, `the open chapter has written directions (${steps} steps)`);

  // 3. switching chapters changes the reading column
  const firstHead = await page.locator('.guide-body h4').textContent();
  await page.locator('.guide-chap', { hasText: 'Ride mode' }).click();
  await page.waitForTimeout(300);
  const rideHead = await page.locator('.guide-body h4').textContent();
  check(rideHead !== firstHead && /ride/i.test(rideHead), `chapter switch lands on Ride mode ("${rideHead}")`);
  check(await page.locator('.guide-steps li', { hasText: 'foreground' }).count() > 0,
    'the Ride chapter states the real limits (foreground GPS)');

  // 4. an un-recorded video degrades to a named placeholder, never a dead player
  await page.waitForTimeout(600);
  const todo = page.locator('.g-video-todo');
  check(await todo.count() === 1, 'a missing clip renders the placeholder, not a broken player');
  check((await todo.textContent()).includes('/guide/'),
    'the placeholder names the file to record');

  // 5. search filters the rail
  await page.fill('.guide-search', 'toll');
  await page.waitForTimeout(250);
  const hits = await page.locator('.guide-chap').count();
  check(hits > 0 && hits < chapters, `search narrows the rail (${hits}/${chapters} for "toll")`);
  await page.fill('.guide-search', 'zzzzz');
  await page.waitForTimeout(250);
  check(await page.locator('.guide-empty').count() === 1, 'a search with no hits says so');
  await page.fill('.guide-search', '');
  await page.waitForTimeout(250);

  // 6. nothing overflows sideways at this width
  check(await fits(page, '.guide-modal') !== false, 'guide sheet does not scroll sideways');
  check(await fits(page, '.guide-body') !== false, 'reading column does not scroll sideways');
  await page.screenshot({ path: SHOT(`guide-${width}`) });

  // 7. Escape closes
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(await page.locator('.guide-modal').count() === 0, 'Escape closes the guide');

  // 8. #help deep link opens it cold, at the named chapter
  await page.goto('http://localhost:5199/#help-crew');
  await page.waitForSelector('.guide-modal', { timeout: 8000 });
  const crewHead = await page.locator('.guide-body h4').textContent();
  check(/crew/i.test(crewHead), `#help-crew opens that chapter ("${crewHead}")`);
  await page.locator('.modal-head .btn').click();
  await page.waitForTimeout(300);
  check(!(await page.evaluate(() => window.location.hash)).startsWith('#help'),
    'closing drops the #help hash so a reload does not reopen it');

  // 9. it is reachable from inside a trip, through Settings → About
  await page.click('.trip-card:not(.guide-card):not(.start-card)');
  await page.waitForSelector('.modebar', { timeout: 20000 });
  await page.locator('.masthead .actions .btn.icon').last().click();
  await page.waitForSelector('.modal.settings', { timeout: 8000 });
  await page.locator('.set-tabs button, .tabbar button', { hasText: 'About' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('.btn.gold', { hasText: 'How to use Roadbook' }).click();
  await page.waitForSelector('.guide-modal', { timeout: 8000 });
  check(true, 'Settings → About opens the guide from inside a trip');

  await page.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
