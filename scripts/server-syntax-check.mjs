// Import every server module, so a syntax error in one cannot reach a deploy.
//
// `vite build` only ever compiles what the client imports; netlify/ is bundled
// by Netlify at deploy time, so a broken function is invisible locally until
// production answers 500. That is exactly how a backtick inside the planner's
// backtick-delimited system prompt got committed: the client build was green,
// the browser sims mocked the planner, and nothing loaded the module.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dirs = ['netlify/functions', 'netlify/lib'];
let checked = 0;
const failed = [];

for (const dir of dirs) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs') && !name.endsWith('.js')) continue;
    const path = `../${join(dir, name)}`;
    try {
      await import(path);
      checked += 1;
    } catch (err) {
      // A module that throws while INITIALISING is a real failure; one that
      // merely needs an env var at call time is not, and does not throw here.
      failed.push(`${join(dir, name)}: ${err.message.split('\n')[0]}`);
    }
  }
}

if (failed.length) {
  console.error(`\nServer modules that will not load (${failed.length}):`);
  for (const f of failed) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`server syntax ok — ${checked} modules load`);
