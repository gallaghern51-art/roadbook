-- Connector tokens: the credential a rider hands to an AI host that cannot
-- do OAuth (a stdio bridge, a script, a desktop app without a browser flow),
-- so it can reach the Roadbook MCP server as them.
--
-- Only the SHA-256 of the token is stored. The plain token is shown once in
-- Settings → Connect your AI and never again; the server hashes the bearer
-- it receives and looks the hash up here (mcp-auth.mjs, service role). The
-- rider can label, list and revoke them — revoked rows stay for the audit.
--
-- Anonymous sessions (the join-code crew door) are excluded, as everywhere
-- a private library is reachable: a crew credential must never mint a key
-- to somebody's whole roadbook.
create table if not exists public.mcp_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  token_hash   text not null unique,
  label        text not null default 'AI connector',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists mcp_tokens_user_idx on public.mcp_tokens (user_id);

alter table public.mcp_tokens enable row level security;

revoke all on table public.mcp_tokens from anon;
revoke all on table public.mcp_tokens from authenticated;
-- The rider makes, lists and revokes their own; the hash is write-once and
-- never needs to be read back by the app (the server reads it as service role).
grant select, insert, update on table public.mcp_tokens to authenticated;

drop policy if exists mcp_tokens_own on public.mcp_tokens;

create policy mcp_tokens_own on public.mcp_tokens for all
  to authenticated
  using (
    user_id = (select auth.uid())
    and coalesce((select (auth.jwt()->>'is_anonymous')::boolean), false) is false
  )
  with check (
    user_id = (select auth.uid())
    and coalesce((select (auth.jwt()->>'is_anonymous')::boolean), false) is false
  );
