import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();

// Netlify exposes the built commit as COMMIT_REF; locally fall back to git, and
// to 'dev' when neither is available (a tarball with no .git, say).
function commitRef() {
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7);
  try { return sh('git rev-parse --short=7 HEAD'); } catch { return 'dev'; }
}

function branch() {
  if (process.env.BRANCH) return process.env.BRANCH;
  try { return sh('git rev-parse --abbrev-ref HEAD'); } catch { return ''; }
}

// The PR number is what the trip owner actually recognises a build by ("is this
// #12?"), so surface it rather than only the commit. Netlify sets REVIEW_ID on
// deploy previews; locally ask gh for the PR open on this branch. Best-effort
// and fully swallowed — a missing gh, no network, or no PR must never fail a
// build, it just leaves the field blank.
function prNumber() {
  if (process.env.REVIEW_ID) return process.env.REVIEW_ID;
  try { return sh('gh pr view --json number -q .number'); } catch { return ''; }
}


// The Netlify functions do not run under plain `vite dev`, which meant the
// shield endpoint 404'd locally and every route fell back to a text chip. That
// gap was quietly driving design decisions — bundling artwork, keeping a
// fallback that looked like a fake sign — so close it instead: dev serves the
// real handler, so what you see locally is what ships.
function netlifyFunctionsInDev() {
  return {
    name: 'netlify-functions-dev',
    apply: 'serve',
    configureServer(server) {
      // Dev has no host request timeout, so the streaming planner does not
      // need to duck under Netlify's ~58s cap here — give local runs the
      // background-size budget unless the shell says otherwise. (Production
      // budgets are unaffected; this process only serves `vite dev`.)
      process.env.PLANNER_BUDGET_MS ||= '600000';
      // Vite only exposes VITE_* to the bundle; the functions read process.env
      // (GOOGLE_MAPS_API_KEY, ANTHROPIC_API_KEY…), so hand them .env/.env.local
      // too — the shell still wins where it already set a value.
      for (const [k, v] of Object.entries(loadEnv('development', process.cwd(), ''))) process.env[k] ??= v;
      server.middlewares.use(async (req, res, next) => {
        // Functions that publish their own path (`export const config = { path }`)
        // are reachable at that path in dev too — the MCP endpoint and its
        // OAuth discovery document are what a connector actually dials.
        const path = (req.url ?? '').split('?')[0];
        const routed = path === '/mcp' || path === '/mcp/' ? 'mcp'
          : path.startsWith('/.well-known/oauth-protected-resource') ? 'mcp-oauth-metadata'
          : null;
        const match = routed ? [null, routed] : /^\/\.netlify\/functions\/([\w-]+)/.exec(req.url ?? '');
        if (!match) return next();
        try {
          const mod = await server.ssrLoadModule(`/netlify/functions/${match[1]}.mjs`);
          const url = new URL(req.url, 'http://localhost');
          // Forward the body — POST functions (collab, chat) read JSON from it.
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          const request = new Request(url, {
            method: req.method,
            headers: req.headers,
            body,
          });
          // Background functions answer 202 immediately on Netlify and keep
          // working; mirror that so the client starts polling planner-status
          // right away instead of blocking on the whole job (which also made
          // it fall back and run the job a second time on the stream path).
          if (match[1].endsWith('-background')) {
            mod.default(request).catch((err) => {
              server.config.logger.error(`[functions-dev] ${match[1]}: ${err?.message ?? err}`);
            });
            res.statusCode = 202;
            res.end();
            return;
          }
          const out = await mod.default(request);
          res.statusCode = out.status;
          out.headers.forEach((v, k) => res.setHeader(k, v));
          // Stream the body through instead of buffering it — the chat
          // function's NDJSON heartbeats and deltas should arrive in dev the
          // way they do in production.
          if (out.body) {
            for await (const chunk of out.body) res.write(chunk);
          }
          res.end();
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err?.message ?? err));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), netlifyFunctionsInDev()],
  // 5199 by default so `npm run dev` is predictable, but an assigned PORT wins
  // — nothing in the app depends on the number (every call is a relative URL),
  // so a tool that hands us a free port should get to.
  server: {
    port: Number(process.env.PORT) || 5199,
    strictPort: Boolean(process.env.PORT),
    // Listen on the LAN so a real iPhone on the same wifi can load the dev
    // build. Ride Mode needs a real GPS fix and real motion — a simulator
    // cannot give it either, so the phone IS the test rig.
    host: true,
  },
  // Surfaced under Settings → Developer tools, so a rider reporting a problem
  // can say which build they are on.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commitRef()),
    __APP_BRANCH__: JSON.stringify(branch()),
    __APP_PR__: JSON.stringify(prNumber()),
    __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
});
