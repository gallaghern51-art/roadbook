// Who is asking? — the MCP server's bearer check.
//
// Two credentials open the door, and both resolve to ONE Supabase account so
// the rider's own AI reads and writes the same library the app does:
//
//   1. A Supabase access token. Supabase Auth is an OAuth 2.1 server
//      (Authentication → OAuth Server), so an MCP host that speaks OAuth —
//      Claude.ai connectors, ChatGPT, Claude Code — discovers it through
//      /.well-known/oauth-protected-resource, sends the rider to the app's
//      consent page, and comes back with a token issued for that rider. We
//      verify it with auth.getUser and, when no service key is configured,
//      simply act THROUGH it: a client bound to the rider's JWT is subject to
//      the same RLS the app is.
//
//   2. A connector token (`rbk_…`) the rider mints in Settings → Connect your
//      AI, for hosts that only take a header (a stdio bridge, a script). Only
//      its SHA-256 is stored (mcp_tokens); resolving one needs the service
//      role key on the server, because a hash lookup is not a session.
//
// Anonymous sessions (the join-code crew door) are refused: that credential
// opens a shared trip, never somebody's private library — the same rule the
// user_trips RLS policy enforces.

import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';

const env = (k) => process.env[k] || '';

export function authConfig() {
  const url = env('SUPABASE_URL') || env('VITE_SUPABASE_URL');
  const key = env('SUPABASE_KEY') || env('VITE_SUPABASE_KEY');
  const service = env('SUPABASE_SERVICE_ROLE_KEY');
  return { url, key, service, configured: Boolean(url && key) };
}

export class AuthError extends Error {
  constructor(message, { status = 401, code = 'invalid_token' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function bearerFrom(req) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export const TOKEN_PREFIX = 'rbk_';
export const isConnectorToken = (t) => typeof t === 'string' && t.startsWith(TOKEN_PREFIX);
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
/** A fresh connector token: 32 random bytes, base64url, prefixed. Shown once. */
export const mintToken = () => TOKEN_PREFIX + randomBytes(32).toString('base64url');

const userClient = (url, key, jwt) => createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { Authorization: `Bearer ${jwt}` } },
});
const serviceClient = (url, service) => createClient(url, service, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

/**
 * @returns {Promise<{userId:string, email:string|null, name:string|null, via:'oauth'|'token', db:object}>}
 * @throws {AuthError}
 */
export async function authenticate(req, { config = authConfig(), clients = {} } = {}) {
  if (!config.configured) throw new AuthError('Roadbook accounts are not configured on this server.', { status: 503, code: 'not_configured' });
  const token = bearerFrom(req);
  if (!token) throw new AuthError('Sign in to Roadbook to use this connector.');

  if (isConnectorToken(token)) {
    if (!config.service) throw new AuthError('Connector tokens need SUPABASE_SERVICE_ROLE_KEY on the server — connect with your Roadbook account (OAuth) instead.', { code: 'invalid_token' });
    const db = clients.service ?? serviceClient(config.url, config.service);
    const { data, error } = await db.from('mcp_tokens')
      .select('id, user_id, revoked_at')
      .eq('token_hash', hashToken(token))
      .maybeSingle();
    if (error) throw new AuthError(`token lookup failed: ${error.message}`, { status: 503, code: 'server_error' });
    if (!data || data.revoked_at) throw new AuthError('This connector token is not valid — make a new one in Roadbook → Settings → Connect your AI.');
    // best effort, never awaited into the request's critical path
    db.from('mcp_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(() => {}, () => {});
    return { userId: data.user_id, email: null, name: null, via: 'token', db };
  }

  // A Supabase access token — from the OAuth flow, or the app's own session.
  const bound = clients.user ?? userClient(config.url, config.key, token);
  const { data, error } = await bound.auth.getUser(token);
  if (error || !data?.user) throw new AuthError('This sign-in has expired — connect Roadbook again.');
  const user = data.user;
  if (user.is_anonymous) throw new AuthError('A crew join code opens one shared trip, not a library. Sign in with a Roadbook account.', { code: 'insufficient_scope' });
  const db = config.service ? (clients.service ?? serviceClient(config.url, config.service)) : bound;
  return {
    userId: user.id,
    email: user.email ?? null,
    name: user.user_metadata?.name ?? null,
    via: 'oauth',
    db,
  };
}

/**
 * The RFC 9728 document an MCP client reads after a 401: which authorization
 * server issues tokens for this resource. Supabase publishes its own metadata
 * at /.well-known/oauth-authorization-server/auth/v1, and MCP clients follow
 * the issuer URL to it.
 */
export function protectedResourceMetadata(resourceUrl, config = authConfig()) {
  const issuer = config.url ? `${config.url.replace(/\/$/, '')}/auth/v1` : null;
  return {
    resource: resourceUrl,
    ...(issuer ? { authorization_servers: [issuer] } : {}),
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid', 'email', 'profile'],
    resource_name: 'Roadbook',
    resource_documentation: 'https://roadbook-app.netlify.app/#help',
  };
}

/** The header that tells a client where to go and sign in. */
export function wwwAuthenticate(resourceMetadataUrl, err) {
  const bits = ['Bearer'];
  const attrs = [`resource_metadata="${resourceMetadataUrl}"`];
  if (err?.code) attrs.push(`error="${err.code}"`);
  if (err?.message) attrs.push(`error_description="${String(err.message).replace(/"/g, "'")}"`);
  return `${bits.join(' ')} ${attrs.join(', ')}`;
}
