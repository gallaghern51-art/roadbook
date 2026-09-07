// Builder progress checks.
//
// Field report (Sep 7, 2026): "on roadbook when the AI builder is going, it
// cuts off at this update prompt and freezes at 10s or some second" and "you
// can see the workflow as it goes but doesn't print til the end".
//
// Two independent faults:
//   1. planner-background's write throttle latched. `pending = write()` runs
//      write()'s body FIRST (which cleared `pending`) and only then stored the
//      promise — which nothing ever cleared. After one throttled write the
//      `!pending` guard was false forever, so record.ms froze at whatever the
//      first progress emit measured. The client's counter reads record.ms.
//   2. Nothing emits at all during a tool round (Places lookups + Valhalla
//      evaluations), so even a working throttle goes quiet for tens of seconds.
//
// These run the REAL background handler against a fake blob store and a fake
// planner core, so the throttle, the heartbeat and the terminal write are the
// code that ships.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fake store
// Records every write so a frozen `ms` is directly observable.
function fakeStore(latencyMs = 0) {
  const writes = [];
  return {
    writes,
    store: {
      async setJSON(_id, rec) {
        if (latencyMs) await sleep(latencyMs);
        writes.push(structuredClone(rec));
      },
    },
  };
}

const coreMod = await import('../netlify/lib/planner-core.mjs');

let active = null; // { store }

// The handler destructures named imports, which cannot be monkeypatched on a
// module namespace. Evaluate its real source with the dependencies injected
// instead, so the throttle, heartbeat and terminal write under test are the
// lines that ship.
const src = readFileSync(resolve(root, 'netlify/functions/planner-background.mjs'), 'utf8');
const body = src
  .replace(/^import[^\n]*\n/gm, '')
  .replace(/^export default async \(req\) => \{/m, 'return async (req) => {')
  .replace(/\n\};\s*$/, '\n};\n');
// eslint-disable-next-line no-new-func
const makeHandler = new Function(
  'jobStore', 'makeClient', 'runChat', 'runExplore', 'runGenerate', 'friendlyError', 'BACKGROUND_BUDGET_MS',
  body,
);

const handlerWith = (run) => makeHandler(
  async () => active.store,
  () => ({}),
  run, run, run,
  (e) => String(e?.message ?? e),
  600000,
);

const req = (payload) => ({ json: async () => payload });

process.env.ANTHROPIC_API_KEY = 'test-key';

// ---------------------------------------------- 1. the throttle must not latch
{
  const { store, writes } = fakeStore();
  active = { store };
  // Emit steadily for ~3.5s, the way a model's thinking deltas do. With
  // FLUSH_MS at 900 that is roughly one write every 900ms plus the claim.
  const handler = handlerWith(async ({ emit }) => {
    const until = Date.now() + 3500;
    while (Date.now() < until) {
      emit({ type: 'building', chars: 100, thinking: 100 });
      await sleep(50);
    }
    emit({ type: 'done', text: 'finished', concepts: [] });
  });
  await handler(req({ jobId: 'j1', mode: 'explore' }));

  const progress = writes.filter((w) => w.status === 'running');
  ok('throttled progress writes keep happening (not one and then silence)',
    progress.length >= 3, `${progress.length} running writes`);

  const stamps = progress.map((w) => w.ms);
  const advanced = stamps[stamps.length - 1] - stamps[0];
  ok('record.ms advances across the run', advanced > 1500, `advanced ${advanced}ms across ${stamps.length}`);
  ok('record.ms is monotonic', stamps.every((v, i) => i === 0 || v >= stamps[i - 1]), JSON.stringify(stamps));

  const last = writes[writes.length - 1];
  ok('terminal write carries done', last.status === 'done' && last.text === 'finished');
}

// ------------------------------- 2. the heartbeat covers a silent tool round
{
  const { store, writes } = fakeStore();
  active = { store };
  // Exactly the shape of answerToolCalls: one beat, then seconds of Places +
  // Valhalla work with nothing to say.
  const handler = handlerWith(async ({ emit }) => {
    emit({ type: 'beat', note: 'searching places' });
    await sleep(3000); // silent tool work
    emit({ type: 'done', text: 'done after tools', concepts: [] });
  });
  await handler(req({ jobId: 'j2', mode: 'explore' }));

  const progress = writes.filter((w) => w.status === 'running');
  ok('heartbeat writes during a silent tool round',
    progress.length >= 3, `${progress.length} running writes`);
  const stamps = progress.map((w) => w.ms);
  ok('elapsed keeps climbing with zero emits',
    stamps[stamps.length - 1] - stamps[0] > 1500, `advanced ${stamps[stamps.length - 1] - stamps[0]}ms`);
  ok('the phase note rides the polled record',
    progress.some((w) => w.note === 'searching places'));
  const firstDone = writes.findIndex((w) => w.status === 'done');
  ok('nothing reports running after the job is done',
    firstDone >= 0 && writes.slice(firstDone).every((w) => w.status === 'done'),
    `first done at ${firstDone} of ${writes.length}`);
}

// ------------------------------- 3. heartbeat never outlives / corrupts the end
{
  const { store, writes } = fakeStore();
  active = { store };
  const handler = handlerWith(async ({ emit }) => {
    emit({ type: 'building', chars: 10, thinking: 10 });
    await sleep(1200);
    throw new Error('valhalla exploded');
  });
  await handler(req({ jobId: 'j3', mode: 'explore' }));
  const before = writes.length;
  await sleep(1400); // a leaked interval would write again here
  ok('the heartbeat stops when the job ends', writes.length === before, `${writes.length} vs ${before}`);
  ok('a thrown failure still reaches the record as an error',
    writes[writes.length - 1].status === 'error'
    && /valhalla exploded/.test(writes[writes.length - 1].message));
}

// --------------------------- 4. overlapping slow writes do not stall progress
{
  const { store, writes } = fakeStore(700); // a slow blob store
  active = { store };
  const handler = handlerWith(async ({ emit }) => {
    const until = Date.now() + 3500;
    while (Date.now() < until) {
      emit({ type: 'building', chars: 50, thinking: 50 });
      await sleep(40);
    }
    emit({ type: 'done', text: 'slow store', concepts: [] });
  });
  await handler(req({ jobId: 'j4', mode: 'explore' }));
  const progress = writes.filter((w) => w.status === 'running');
  ok('a slow store still gets repeated progress writes',
    progress.length >= 2, `${progress.length} running writes`);
  ok('a slow store still finishes', writes[writes.length - 1].status === 'done');
}

// ------------------------------------------- 5. the reasoning line is readable
{
  const { lastLine } = coreMod;
  ok('lastLine takes the last non-empty line',
    lastLine('planning the route\n\nchecking fuel gaps') === 'checking fuel gaps');
  ok('lastLine strips heading and emphasis marks',
    lastLine('## **Evaluating the Catskills option**') === 'Evaluating the Catskills option');
  const long = lastLine('x'.repeat(400));
  ok('lastLine fits one row', long.length <= 120 && long.endsWith('…'), `${long.length} chars`);
  ok('lastLine survives empty input', lastLine('') === '' && lastLine(null) === '' && lastLine(undefined) === '');
  ok('lastLine never splices an ellipsis mid-sentence',
    !lastLine('a short line').includes('…'));
}

// -------------------------- 6. trackProgress carries the reasoning, not just a count
{
  const { trackProgress } = coreMod;
  const handlers = {};
  const stream = { on: (name, fn) => { handlers[name] = fn; } };
  const emitted = [];
  trackProgress(stream, (obj) => emitted.push(obj));
  const think = (text) => handlers.streamEvent({
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking: text },
  });
  // The ping threshold is 400 characters, so a realistic first paragraph has to
  // land before the line under test.
  think(`Scoping two distinct concepts from Weehawken. ${'Weighing the Hudson Highlands loop against a longer Catskills push. '.repeat(5)}\n`);
  think('Checking whether the Catskills run needs a fuel stop before Tannersville');
  think(' — 255 miles is over comfort range.');
  ok('a building event carries a thought line', emitted.length > 0 && !!emitted[emitted.length - 1].thought);
  const thought = emitted[emitted.length - 1].thought;
  ok('the thought is the CURRENT line, not the first one',
    thought.startsWith('Checking whether the Catskills run'), thought);
  ok('the thought is not a mid-sentence ellipsis splice',
    (thought.match(/…/g) ?? []).length <= 1, thought);
  ok('character counts still ride along', emitted[emitted.length - 1].thinking > 0);
}

// ------------------- 7. the client forwards the note and thought from a poll
{
  const planner = readFileSync(resolve(root, 'src/engine/planner.js'), 'utf8');
  ok('planner.js replays thought from the polled record', /thought: rec\.thought/.test(planner));
  ok('planner.js replays the phase note', /note: rec\.note/.test(planner));
  ok('planner.js replays new text as deltas', /type: 'delta', text: rec\.text\.slice\(deliveredText\)/.test(planner));
}

// ------------------------------- 8. the builder renders the stream as it arrives
{
  const ui = readFileSync(resolve(root, 'src/components/TripConstructionChat.jsx'), 'utf8');
  ok('the builder consumes delta text', /obj\.type === 'delta'/.test(ui));
  ok('the streamed text is rendered while busy', /live && <span className="live-text">/.test(ui));
  ok('the reasoning line is rendered', /progress\?\.thought/.test(ui));
  ok('both research and build read the same stream handler',
    (ui.match(/\}, readLine\)/g) ?? []).length === 2);
  ok('a failed round keeps what streamed', /partial: true/.test(ui));
  ok('the thread follows the stream', /scrollIntoView/.test(ui));
  ok('the verify phase has a label', /verifying option stops/.test(ui));
}

console.log(`\n${pass}/${pass + fail} builder progress checks passed`);
process.exit(fail ? 1 : 0);
