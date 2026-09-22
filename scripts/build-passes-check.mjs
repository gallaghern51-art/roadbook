// Building a long trip in passes — the pure half (Sep 21, 2026).
//
// Owner: a 30-day build hit the planner's budget and the app told them to
// split it; on the retry the model chunked it into four-day pieces by itself.
// The size of a request is known BEFORE it is sent — the intake carries the
// day count — so the passes are decided up front, sized to the transport,
// each told where the last ended. This checks the arithmetic, the digest a
// pass is handed, and the instruction the server gives the model.
//
// Run: node scripts/build-passes-check.mjs   (or npm run passes:check)

import { PASS_DAYS, passSizeFor, needsPasses, nextPass, passLabel, priorDaysDigest, shrinkPass } from '../src/engine/buildPasses.js';
import { generateAsk, runGenerate } from '../netlify/lib/planner-core.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('pass sizing:');
{
  check('background carries eight days, streaming four', PASS_DAYS.background === 8 && PASS_DAYS.stream === 4 && passSizeFor('stream') === 4 && passSizeFor('background') === 8);
  check('an unknown transport is sized like streaming (the smaller budget)', passSizeFor(undefined) === 4);
  check('a five-day trip is one call on either transport', !needsPasses(5, 'background') && !needsPasses(4, 'stream'));
  check('a thirty-day trip needs passes on both', needsPasses(30, 'background') && needsPasses(30, 'stream'));
  const passes = [];
  for (let from = 1, p; (p = nextPass(from, 30, 8)); from = p.to + 1) passes.push(p);
  check('thirty days at eight per pass is 1–8, 9–16, 17–24, 25–30', passes.map((p) => `${p.from}-${p.to}`).join(',') === '1-8,9-16,17-24,25-30', passes.map((p) => `${p.from}-${p.to}`).join(','));
  check('only the final pass is marked last', passes.filter((p) => p.last).length === 1 && passes[3].last && passes[3].total === 30);
  check('past the end there is no pass', nextPass(31, 30, 8) === null);
  check('a single-day trip is one pass of one day', JSON.stringify(nextPass(1, 1, 8)) === JSON.stringify({ from: 1, to: 1, total: 1, last: true }));
  check('the label names the days being built', passLabel({ from: 9, to: 16, total: 30 }) === 'Building days 9–16 of 30' && passLabel({ from: 1, to: 5, total: 5 }) === 'Writing the confirmed trip');
  check('a pass that did not fit halves, never below two', shrinkPass(8) === 4 && shrinkPass(4) === 2 && shrinkPass(2) === 2 && shrinkPass(3) === 2);
}

console.log('the digest a pass is handed:');
{
  const days = Array.from({ length: 8 }, (_, i) => ({
    date: `2027-06-0${i + 1}`, title: `Day ${i + 1}`, phase: 'outbound',
    waypoints: [{ name: `Town ${i}`, lat: 45 + i, lng: -110 }, { name: `Fuel ${i}`, lat: 45.5 + i, lng: -110.2 }, { name: `Town ${i + 1}`, lat: 46 + i, lng: -110, placeId: `pl${i + 1}` }],
    lodging: { name: `Motel ${i + 1}` },
  }));
  const d = priorDaysDigest(days);
  check('one entry per built day, numbered', d.length === 8 && d[0].day === 1 && d[7].day === 8);
  check('older days carry only their title', !('to' in d[0]) && d[0].title === 'Day 1' && !('to' in d[3]));
  check('the most recent days carry where they ended, with coordinates and place id', d[7].to?.name === 'Town 8' && d[7].to.lat === 53 && d[7].to.placeId === 'pl8' && d[4].to?.name === 'Town 5');
  check('the lodging name rides along', d[7].lodging === 'Motel 8' && d[7].stops === 3);
  check('an empty build digests to nothing', priorDaysDigest([]).length === 0 && priorDaysDigest(undefined).length === 0);
}

console.log('the instruction the model gets:');
{
  const basics = { name: 'Big Loop', startDate: '2027-06-01', numDays: 30, riders: 2 };
  const single = generateAsk({ prompt: 'a loop', basics });
  check('no range → the ask is what it always was', /days: 30, riders: 2\. Use the generate_trip tool\.$/.test(single) && !/THIS CALL BUILDS/.test(single), single.slice(-120));
  const whole = generateAsk({ prompt: 'a loop', basics, dayRange: { from: 1, to: 30, total: 30 } });
  check('a range covering the whole trip is the plain ask too', whole === single);
  const first = generateAsk({ prompt: 'a loop', basics, dayRange: { from: 1, to: 8, total: 30 }, priorDays: [] });
  check('the first pass asks for exactly its days and forbids arriving early', /BUILDS DAYS 1–8 OF THE 30-DAY TRIP/.test(first) && /Emit exactly 8 days/.test(first) && /Day 8 must END at an overnight/.test(first) && /reached on day 30, which is NOT part of this call/.test(first) && !/already built/.test(first), first.slice(-300));
  const mid = generateAsk({ prompt: 'a loop', basics, dayRange: { from: 9, to: 16, total: 30 }, priorDays: [{ day: 8, title: 'Day 8', to: { name: 'Cody, WY', lat: 44.5, lng: -109 } }] });
  check('a middle pass is told the built days and to start where day 8 ended', /Days 1–8 are already built and must not be repeated/.test(mid) && /Cody, WY/.test(mid) && /Day 9 STARTS where day 8 ended/.test(mid) && /never days before 9 or after 16/.test(mid));
  const last = generateAsk({ prompt: 'a loop', basics, dayRange: { from: 25, to: 30, total: 30 }, priorDays: [] });
  check('the last pass ends at the destination and emits six days', /Emit exactly 6 days/.test(last) && /Day 30 ends at the trip's final destination/.test(last) && !/must END at an overnight/.test(last));
  const one = generateAsk({ prompt: 'a loop', basics, dayRange: { from: 30, to: 30, total: 30 }, priorDays: [] });
  check('a one-day pass says "1 day"', /Emit exactly 1 day in/.test(one));
}

console.log('the done event carries the range back:');
{
  // a fake Anthropic client whose stream yields one generate_trip tool call
  const fakeClient = {
    messages: {
      stream: () => {
        const response = { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'generate_trip', input: { trip: { meta: { title: 'Big Loop' }, days: [{ title: 'Day 9', waypoints: [{ name: 'Cody', lat: 44.5, lng: -109 }, { name: 'Red Lodge', lat: 45.19, lng: -109.25 }] }] } } }] };
        const s = {
          on: () => s,
          finalMessage: async () => response,
          abort: () => {},
          then: (res) => Promise.resolve(response).then(res),
        };
        return s;
      },
    },
  };
  const events = [];
  await runGenerate({ client: fakeClient, body: { prompt: 'x', basics: { numDays: 30 }, dayRange: { from: 9, to: 16, total: 30 }, priorDays: [] }, emit: (e) => events.push(e), budgetMs: 5000, verifyOpts: { key: '' } });
  const done = events.find((e) => e.type === 'done');
  check('runGenerate echoes the dayRange on done', done && done.dayRange?.from === 9 && done.dayRange.to === 16 && done.trip?.days?.length === 1, JSON.stringify(events.map((e) => e.type)));
  const events2 = [];
  await runGenerate({ client: fakeClient, body: { prompt: 'x', basics: { numDays: 1 } }, emit: (e) => events2.push(e), budgetMs: 5000, verifyOpts: { key: '' } });
  check('and omits it for a single-call build', events2.find((e) => e.type === 'done') && !('dayRange' in events2.find((e) => e.type === 'done')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
