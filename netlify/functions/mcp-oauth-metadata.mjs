// GET /.well-known/oauth-protected-resource — RFC 9728.
//
// The document an MCP client reads after /mcp answers 401: this resource is
// protected, and the authorization server that issues its tokens is Supabase
// Auth (the app's own accounts). The client then follows the issuer to
// Supabase's own /.well-known/oauth-authorization-server document, registers
// itself (dynamic client registration), and sends the rider to the app's
// consent page at /oauth/consent. Nothing here is secret.

import { protectedResourceMetadata } from '../lib/mcp-auth.mjs';

export const config = { path: ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'] };

export default async (req) => {
  const u = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || u.host;
  const proto = req.headers.get('x-forwarded-proto') || (/^localhost|^127\./.test(host) ? 'http' : 'https');
  const doc = protectedResourceMetadata(`${proto}://${host}/mcp`);
  return Response.json(doc, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
