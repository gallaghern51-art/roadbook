-- The rider's own profile: the places they keep (home, work, favorites) and
-- how they like to ride. One row per account.
--
-- Separate from user_place_preference_history, which is passive evidence the
-- app infers from selections and rejections. This is what the rider stated
-- outright, and it is editable and deletable by them at any time — which is
-- also why it is one row rather than an append-only log.
--
-- Anonymous sessions (the join-a-shared-trip door) are excluded exactly as
-- user_trips excludes them: a crew credential must not reach a private profile
-- holding somebody's home address.
create table if not exists public.user_profile (
  user_id    uuid primary key references auth.users on delete cascade,
  profile    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_profile enable row level security;

revoke all on table public.user_profile from authenticated;
grant select, insert, update, delete on table public.user_profile to authenticated;
revoke all on table public.user_profile from anon;

drop policy if exists user_profile_own on public.user_profile;

create policy user_profile_own on public.user_profile for all
  to authenticated
  using (
    user_id = (select auth.uid())
    and coalesce((select (auth.jwt()->>'is_anonymous')::boolean), false) is false
  )
  with check (
    user_id = (select auth.uid())
    and coalesce((select (auth.jwt()->>'is_anonymous')::boolean), false) is false
  );
