// POST /mcp — the Roadbook MCP endpoint (Streamable HTTP, stateless JSON).
//
// Any MCP host — Claude.ai / Claude Desktop connectors, ChatGPT, Claude Code,
// Cursor, a script — points at https://roadbook-app.netlify.app/mcp. Every
// request carries a bearer: a Supabase access token from the OAuth flow, or a
// connector token minted in Settings → Connect your AI. A request with none
// gets a 401 whose WWW-Authenticate header names the resource-metadata
// document, which is how an OAuth-capable host discovers Supabase Auth and
// sends the rider to the consent page (RFC 9728 → RFC 8414).
//
// The routing itself is in ../lib/mcp-server.mjs; this file is the door.

import { authenticate, AuthError, wwwAuthenticate } from '../lib/mcp-auth.mjs';
import { handleMcpRequest, SERVER_INFO } from '../lib/mcp-server.mjs';

export const config = { path: ['/mcp', '/mcp/'] };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

const withCors = (res) => {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

const resourceUrl = (req) => {
  const u = new URL(req.url);
  // Netlify terminates TLS and the dev shim rebuilds the URL without its
  // port, so the public origin comes from the headers first.
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || u.host;
  const proto = req.headers.get('x-forwarded-proto') || (/^localhost|^127\./.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const origin = resourceUrl(req);
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;

  // A human in a browser gets a signpost, not a JSON-RPC error.
  if (req.method === 'GET' && /text\/html/.test(req.headers.get('accept') || '') && !/text\/event-stream/.test(req.headers.get('accept') || '')) {
    return withCors(Response.json({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      transport: 'streamable-http',
      endpoint: `${origin}/mcp`,
      auth: { type: 'oauth2', resource_metadata: metadataUrl, alternative: 'Bearer rbk_… connector token from Roadbook → Settings → Connect your AI' },
      docs: 'https://github.com/gallaghern51-art/roadbook/blob/main/docs/mcp-server.md',
    }));
  }

  let session;
  try {
    session = await authenticate(req);
  } catch (e) {
    const err = e instanceof AuthError ? e : new AuthError(String(e?.message ?? e), { status: 503, code: 'server_error' });
    return withCors(Response.json(
      { jsonrpc: '2.0', error: { code: err.status === 401 ? -32001 : -32000, message: err.message }, id: null },
      { status: err.status, headers: err.status === 401 ? { 'WWW-Authenticate': wwwAuthenticate(metadataUrl, err) } : {} },
    ));
  }

  try {
    const res = await handleMcpRequest(req, session, {
      authInfo: { token: 'redacted', clientId: session.via, scopes: ['roadbook'], resource: new URL(`${origin}/mcp`), extra: { session } },
    });
    return withCors(res);
  } catch (e) {
    return withCors(Response.json({ jsonrpc: '2.0', error: { code: -32603, message: String(e?.message ?? e).slice(0, 300) }, id: null }, { status: 500 }));
  }
};
