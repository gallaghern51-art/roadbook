#!/usr/bin/env node
// Roadbook MCP — stdio bridge.
//
// For AI hosts that speak MCP over stdio but not over HTTP (or cannot do the
// OAuth dance): this process reads JSON-RPC from stdin, forwards each message
// to the Roadbook MCP endpoint with a bearer, and writes the answer back to
// stdout. No dependencies; Node 18+.
//
//   ROADBOOK_TOKEN=rbk_…  node mcp/bridge.mjs
//   ROADBOOK_MCP_URL      (default https://roadbook-app.netlify.app/mcp)
//
// Claude Desktop (claude_desktop_config.json):
//   { "mcpServers": { "roadbook": { "command": "node",
//       "args": ["/path/to/roadbook/mcp/bridge.mjs"],
//       "env": { "ROADBOOK_TOKEN": "rbk_…" } } } }
//
// The token comes from Roadbook → Settings → Connect your AI. Notifications
// (no id) are forwarded and produce no reply; the endpoint is stateless, so
// there is no session to keep.

import { createInterface } from 'node:readline';

const URL_ = (process.env.ROADBOOK_MCP_URL || 'https://roadbook-app.netlify.app/mcp').replace(/\/$/, '');
const TOKEN = process.env.ROADBOOK_TOKEN || '';

if (!TOKEN) {
  process.stderr.write('roadbook-mcp: set ROADBOOK_TOKEN (Roadbook → Settings → Connect your AI)\n');
}

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

async function forward(msg) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(msg),
  });
  const ct = res.headers.get('content-type') || '';
  const body = await res.text();
  if (res.status === 202 || !body.trim()) return null; // a notification, acknowledged
  if (ct.includes('text/event-stream')) {
    // stateless JSON is the default here; tolerate SSE anyway
    const out = [];
    for (const line of body.split('\n')) if (line.startsWith('data:')) { try { out.push(JSON.parse(line.slice(5).trim())); } catch { /* keepalive */ } }
    return out;
  }
  try { return JSON.parse(body); } catch { return { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: `bad answer (${res.status}): ${body.slice(0, 200)}` } }; }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  try {
    const out = await forward(msg);
    if (out == null) return;
    for (const m of Array.isArray(out) ? out : [out]) write(m);
  } catch (e) {
    if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `roadbook unreachable: ${e.message}` } });
  }
});
rl.on('close', () => process.exit(0));
