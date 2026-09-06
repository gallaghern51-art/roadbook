-- Private per-account library backup. Shared-trip collaboration continues to
-- use public.trips/trip_members/trip_ops; this table is one rider's own shelf.
create table if not exists public.user_trips (
  user_id    uuid not null references auth.users on delete cascade,
  trip_id    text not null,
  name       text not null,
  trip       jsonb not null,
  scenarios  jsonb not null default '[]'::jsonb,
  chat       jsonb not null default '[]'::jsonb,
  remote     jsonb,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, trip_id)
);

create index if not exists user_trips_user_idx on public.user_trips (user_id);

alter table public.user_trips enable row level security;

revoke all on table public.user_trips from authenticated;
grant select, insert, update, delete on table public.user_trips to authenticated;
revoke all on table public.user_trips from anon;

drop policy if exists user_trips_own on public.user_trips;

create policy user_trips_own on public.user_trips for all
  to authenticated
  using (
    user_id = (select auth.uid())
    and coalesce((select (auth.jwt()->>'is_anonymous')::boolean), false) is false
  )
  with check (
    user_id = (select auth.uid())
    and coalesce((select (auth.jwt()->>'is_anonymous')::boolean), false) is false
  );
