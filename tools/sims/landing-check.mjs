// The front door (Sep 13, 2026 — owner: "massively improve our landing page.
// determine if dark/light is better for landing"). The page is authored DARK
// and pinned dark whatever theme the rider keeps in Settings; the proof on it
// is the product's own Ride Mode — the frame the app would draw here, from data
// we may ship: OpenStreetMap's Red Lodge around the router's real US-212 under
// the chase camera, ZERO map calls per visit (owner: no fake map, then "any way
// to avoid the map call for a landing page visit?") — and the app's own turn
// card / chips / bar. The primary action
// is the product (Plan a trip with AI → guest), and the account is argued for
// lower down. Supabase keys must be present in .env.local or the gate never
// renders (the sims skip it the same way). Mapbox is mocked by the shared
// fixture only to PROVE the page never calls it.
//
//   npm run dev                      # :5199 (or RB_PORT=… for another port)
//   node tools/sims/landing-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile, mbLog } from './fixtures/mapbox-mock.mjs';
import { LANDING_REMAINING_MI } from '../../src/data/landingRoute.js';
import { FRAME_ROADS, FRAME_POIS, FRAME_PUCK, FRAME_ROUTE } from '../../src/data/landingFrame.js';

const PORT = process.env.RB_PORT || 5199;
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const MI = Math.round(LANDING_REMAINING_MI);
const PIVOT = [215, 661]; // LandingFrame.PIVOT (a .jsx cannot be imported under plain node)

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function run(width, theme) {
  console.log(`\n── ${width}px · stored theme ${theme} ──`);
  const phone = width < 820;
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const mbStart = mbLog.length; // the log is shared across runs; Home's own map (after the guest click) is not the landing's
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('PAGEERROR', e.message); });
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes(`localhost:${PORT}`) || u.includes('supabase') || u.includes('fonts.g')) return r.continue();
    return r.abort();
  });
  await page.addInitScript((theme) => {
    localStorage.setItem('moto.settings.v1', JSON.stringify({ lang: 'en', theme, units: 'imperial', shields: true, density: 'detailed' }));
    localStorage.removeItem('moto.guest.v1');
  }, theme);
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('.landing', { timeout: 15000 });
  await page.waitForTimeout(1200);

  const s = await page.evaluate(() => {
    const L = document.querySelector('.landing');
    const cs = getComputedStyle(L);
    const q = (sel) => document.querySelector(sel);
    const rect = (sel) => q(sel)?.getBoundingClientRect();
    const under44 = [...document.querySelectorAll('button, a')].filter((b) => b.offsetParent && !b.closest('.inst') && !b.closest('.build-mock') && !b.closest('.mapboxgl-ctrl')).map((b) => ({ t: b.textContent.trim().slice(0, 24), h: Math.round(b.getBoundingClientRect().height) })).filter((b) => b.h < 44);
    const fields = [...document.querySelectorAll('input')].map((e) => parseFloat(getComputedStyle(e).fontSize));
    const h2 = q('.land-pitch h2');
    const chipsCentered = (() => {
      const r = q('.ride-mock .ride-chips').getBoundingClientRect(); const c = q('.ride-mock .m-chip.fuel').getBoundingClientRect(); const g = q('.ride-mock .m-chip.gate').getBoundingClientRect();
      const mid = (r.left + r.right) / 2;
      const pair = Math.abs((c.left + g.right) / 2 - mid) < 3 && c.right < g.left;
      const each = Math.abs((c.left + c.right) / 2 - mid) < 3 && Math.abs((g.left + g.right) / 2 - mid) < 3;
      return pair || each;
    })();
    const noEllipsis = (() => {
      const d = q('.ride-mock .rb-day'); const m = q('.ride-mock .rb-mid'); const n = q('.ride-mock .mq-box');
      return d.scrollWidth <= d.clientWidth + 1 && m.scrollWidth <= m.clientWidth + 1 && n.scrollWidth <= n.clientWidth + 1;
    })();
    const map = (() => {
      const g = q('.ride-mock .rm-frame'); if (!g) return null;
      const svg = g.querySelector('.rm-plane svg');
      const puck = q('.ride-mock .rm-puck');
      const pr = puck?.getBoundingClientRect(); const fr = g.getBoundingClientRect();
      return {
        svg: !!svg, canvas: !!g.querySelector('canvas'), roads: svg?.querySelectorAll('g[stroke] path').length ?? 0,
        ahead: svg?.querySelectorAll('path[stroke="#56c5c8"]').length ?? 0, done: svg?.querySelectorAll('path[stroke="#264f51"]').length ?? 0, labels: svg?.querySelectorAll('textPath').length ?? 0,
        pois: [...document.querySelectorAll('.ride-mock .rm-poi span')].map((e) => e.textContent), navPuck: !!puck?.querySelector('.nav-puck'),
        puckAt: pr && fr ? [(pr.left - fr.left) / fr.width, (pr.top - fr.top) / fr.height] : null,
        tilted: /matrix3d|rotateX/.test(getComputedStyle(q('.ride-mock .rm-plane')).transform),
        credit: q('.ride-mock .rm-credit')?.textContent ?? '', mapboxLogo: !!q('.ride-mock .mapboxgl-ctrl-logo'),
      };
    })();
    return {
      theme: document.documentElement.dataset.theme, bg: cs.backgroundColor, ink: cs.color,
      wider: L.scrollWidth > L.clientWidth || document.documentElement.scrollWidth > innerWidth,
      go: rect('.land-go'), art: rect('.ride-mock'), h2lines: Math.round(h2.getBoundingClientRect().height / parseFloat(getComputedStyle(h2).lineHeight)),
      h2clipped: h2.scrollWidth > h2.clientWidth + 1,
      steps: document.querySelectorAll('.land-step').length, features: document.querySelectorAll('.land-feature').length,
      templates: [...document.querySelectorAll('.land-template .lt-title')].map((e) => e.textContent).filter((t) => /Sturgis|Early Exit/.test(t)), sturgisTemplate: /Start from the Sturgis template|Sturgis Trip Template/.test(L.textContent),
      chips: [...document.querySelectorAll('.ride-mock .m-chip')].map((e) => e.textContent.trim()), turn: q('.ride-mock .t-mi')?.textContent, row2: q('.ride-mock .rb-mid')?.textContent ?? '',
      wx: q('.ride-mock .ride-chip.wx .wxc-temp')?.textContent, day: q('.ride-mock .rb-day')?.textContent,
      dayMiShown: getComputedStyle(q('.ride-mock .rb-day-mi')).display !== 'none', noEllipsis, chipsCentered,
      cookeOnMap: /cooke/i.test((q('.ride-mock')?.textContent ?? '').replace(/Cooke City · Exxon/, '')),
      toggle: !!q('.landing .theme-toggle'), argue: /argue/i.test(L.textContent),
      under44, fields, hasSkip: !!q('.land-skip'), hasHelp: !!q('.land-help'),
      goAboveFold: rect('.land-go').bottom <= innerHeight,
      desk: (() => {
        const d = q('.build-mock'); if (!d) return null;
        const r = d.getBoundingClientRect();
        return { top: r.top, w: r.width, tabs: d.querySelectorAll('.concept-tabs > span').length, activeTab: d.querySelector('.concept-tabs > span.active > span')?.textContent, stops: d.querySelectorAll('.concept-stop').length, verified: d.querySelectorAll('.stop-verified').length, placed: d.querySelectorAll('.stop-placed').length, facts: d.querySelectorAll('.concept-facts > span').length, refine: d.querySelectorAll('.concept-refine button').length, confirm: d.querySelector('.construction-confirm .btn')?.textContent, streaming: !!d.querySelector('.msg.ai.streaming .thinking'), user: d.querySelector('.msg.user')?.textContent ?? '', wider: [...d.querySelectorAll('*')].some((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== 'hidden' && getComputedStyle(e).textOverflow !== 'ellipsis'), activeW: d.querySelector('.concept-tabs > span.active')?.getBoundingClientRect().width };
      })(),
      chapters: [...document.querySelectorAll('.land-chapters .ls-when')].map((e) => e.textContent), intake: !!q('.land-hero .inst-intake'), narr: !!q('.inst-narr .msg.ai.streaming'), prep: !!q('.inst-prep .prep-hero .ph-grade'), tmpl: !!q('.inst-template .land-template .silhouette'),
      hero: (q('.land-pitch h2')?.textContent ?? '') + ' ' + (q('.land-sub')?.textContent ?? ''), eyebrow: !!q('.land-eyebrow'),
      map,
    };
  });
  check(s.bg === 'rgb(8, 10, 11)' && s.ink === 'rgb(246, 243, 235)', `the door is DARK regardless of the stored theme (data-theme=${s.theme}: bg ${s.bg}, ink ${s.ink})`);
  check(!s.toggle, 'no theme toggle on the door — theme is a Settings preference inside the app');
  check(!s.wider, 'nothing scrolls sideways');
  check(s.h2lines === 2 && !s.h2clipped, `the headline is two lines and not clipped (${s.h2lines})`);
  check(s.goAboveFold, 'Plan a trip with AI is above the fold');
  // the AI builder is the hero
  check(s.desk && s.desk.tabs === 3 && /Beartooth/.test(s.desk.activeTab) && s.desk.stops >= 6 && s.desk.verified >= 5 && s.desk.placed === 1 && s.desk.facts >= 5 && s.desk.refine === 3 && /Create this trip/.test(s.desk.confirm) && s.desk.streaming && /Sturgis by 4/.test(s.desk.user),
    `chapter two is the app's own builder after one turn: the rider's sentence, the planner narrating, three measured options, verified + placed stops, three refinements, Create this trip (${s.desk?.stops} stops, ${s.desk?.verified} verified)`);
  check(s.desk && !s.desk.wider && (!phone || s.desk.activeW > s.desk.w - 4), 'nothing in the desk overflows; on a phone the one visible option spans the row');
  check(/Plan the ride\. ?Then ride the plan\./.test(s.hero.replace(/\s+/g, ' ')) && /Tell Roadbook the ride in a sentence/.test(s.hero) && !s.eyebrow, 'the headline is the owner\'s line and the sub says tell it the ride in a sentence; no eyebrow');
  check(s.chapters.length === 6 && /Six weeks out/.test(s.chapters[0]) && /Next year/.test(s.chapters[5]) && s.intake && s.narr && s.prep && s.tmpl, `Direction C: six chapters in order with their instruments — intake in the hero, narration, the desk, the grade, the Prep board, Ride Mode, the shared template (${s.chapters.join(' · ')})`);
  check(s.art && s.art.width >= 260 && s.art.width <= 345 && Math.abs(s.art.height / s.art.width - 932 / 430) < 0.05, `Ride Mode is on the page as a phone (step 3), laid out at 430×932 and scaled (${Math.round(s.art?.width)}×${Math.round(s.art?.height)})`);
  // the frame is drawn from data we may ship, and costs nothing per visit
  check(s.map && s.map.svg && !s.map.canvas && s.map.tilted, 'the ground is an SVG plane under the chase camera\'s tilt — no map canvas');
  check(s.map && s.map.roads >= 100 && s.map.roads <= FRAME_ROADS.length + 40 && s.map.labels >= 8, `Red Lodge's real streets from OpenStreetMap, named (${s.map?.roads} ways, ${s.map?.labels} labels)`);
  check(s.map && s.map.ahead === 2 && s.map.done === 1 && FRAME_ROUTE.length > 300 && FRAME_PUCK > 0, 'the router\'s real US-212 is drawn as the lit road ahead and the completed piece behind');
  check(s.map && s.map.pois.length >= 3 && s.map.pois.every((n) => FRAME_POIS.some((p) => p.n === n)), `real named places from OpenStreetMap on the frame (${s.map?.pois.join(' · ')})`);
  check(s.map && s.map.navPuck && s.map.puckAt && Math.abs(s.map.puckAt[0] - PIVOT[0] / 430) < 0.03 && Math.abs(s.map.puckAt[1] - PIVOT[1] / 932) < 0.03, 'the app\'s own puck sits in the lower third, on the road');
  check(s.map && /OpenStreetMap contributors/.test(s.map.credit) && !s.map.mapboxLogo, 'OpenStreetMap is credited (ODbL); no Mapbox content, no Mapbox wordmark');
  check(!mbLog.slice(mbStart).some((u) => /api\.mapbox\.com|events\.mapbox\.com/.test(u)), `the landing page made ZERO Mapbox requests (${mbLog.length - mbStart} logged)`);
  // the HUD is the app's HUD and agrees with itself
  check(s.chips.length === 2 && s.chips[0] === `${MI} mi` && s.row2.includes(`${MI} mi`) && s.turn === `${MI} mi` && /Check-in/.test(s.chips[1]) && s.chipsCentered,
    `the fuel chip, the leg and the turn card all read the router's real distance to Cooke City (${MI} mi); centred chip row; gate chip`);
  check(/°/.test(s.wx) && /Day 5:40 PM · 187 mi/.test(s.day) && s.dayMiShown && s.noEllipsis, 'weather chip + ✕, the day line with its miles, no ellipsis anywhere in the bar');
  check(!s.cookeOnMap, `nothing of Cooke City on a screen that is ${MI} mi from it`);
  check(!s.sturgisTemplate && s.templates.length === 0, 'no built-in template pitch on the door (sharing rides is a feature to come)');
  check(!s.argue, 'the word "argue" is gone from the door');
  check(s.hasSkip && s.hasHelp, 'Continue without an account + See how it works are still there');
  if (phone) {
    check(s.under44.length === 0, `every control is ≥44px on a phone ${s.under44.length ? JSON.stringify(s.under44) : ''}`);
    check(s.fields.every((v) => v >= 16), `no field under 16px (${s.fields.join(',')})`);
  }
  await page.screenshot({ path: SHOT(`landing-${width}-${theme}`) });

  // the mast's Sign in scrolls to the card and focuses the email
  await page.locator('.land-nav-signin').click();
  // smooth scroll over a long phone page takes more than a second to settle
  await page.waitForFunction(() => document.querySelector('.land-account').getBoundingClientRect().top < 120, null, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);
  const s2 = await page.evaluate(() => ({ focused: document.activeElement?.type === 'email', top: document.querySelector('.land-account').getBoundingClientRect().top, heading: document.querySelector('.auth-card h3').textContent }));
  check(s2.focused && s2.top < 120 && /Sign in/.test(s2.heading), `Sign in scrolls to the card and focuses email (top ${Math.round(s2.top)}px)`);
  // the hero's second action opens the guide; the card's own link switches to signup
  await page.evaluate(() => document.querySelector('.landing').scrollTo(0, 0));
  await page.locator('.land-second').click();
  await page.waitForTimeout(900);
  const guide = await page.locator('.guide, .help-guide, [class*="guide"]').first().isVisible().catch(() => false);
  check(guide, 'See how it works opens the guide from the hero');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.locator('.auth-alt button', { hasText: 'Create an account' }).first().click();
  await page.waitForTimeout(500);
  const s3 = await page.evaluate(() => ({ heading: document.querySelector('.auth-card h3').textContent, why: !!document.querySelector('.auth-why'), name: !!document.querySelector('.auth-field input[autocomplete="name"]') }));
  check(/Create your account/.test(s3.heading) && s3.why && s3.name, 'the card\'s Create an account switches it to signup with the why');
  // the primary action is the product: guest lands on Home
  await page.evaluate(() => document.querySelector('.landing').scrollTo(0, 0));
  await page.locator('.land-go').click();
  const home = await page.waitForSelector('.home, .home-map', { timeout: 15000 }).then(() => true).catch(() => false);
  check(home, 'Plan a trip with AI opens the app as a guest');
  check(pageErrors.length === 0, `zero page errors (${pageErrors.length})`);
  await ctx.close();
}

await run(1280, 'light');
await run(375, 'dark');
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
