-- Private evidence used to personalize future place recommendations.
-- Events are append-only so the preference model can distinguish a casual
-- option selection from a final confirmation and from an explicit rejection.
create table if not exists public.user_place_events (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users on delete cascade,
  place_id      text not null,
  kind          text not null check (kind in ('food', 'lodging', 'attraction')),
  action        text not null check (action in ('selected', 'rejected', 'confirmed')),
  source        text not null default 'ai_construction',
  option_id     text,
  traits        jsonb not null default '{"tags": []}'::jsonb
                constraint user_place_events_traits_shape_check check (
                  jsonb_typeof(traits) = 'object'
                  and (traits - 'tags') = '{}'::jsonb
                  and jsonb_typeof(traits->'tags') = 'array'
                  and jsonb_array_length(traits->'tags') <= 3
                ),
  created_at    timestamptz not null default now()
);

create index if not exists user_place_events_user_time_idx
  on public.user_place_events (user_id, created_at desc);
create index if not exists user_place_events_user_place_idx
  on public.user_place_events (user_id, place_id);

alter table public.user_place_events enable row level security;

revoke all on table public.user_place_events from authenticated;
grant select, insert, delete on table public.user_place_events to authenticated;
revoke all on table public.user_place_events from anon;
revoke all on sequence public.user_place_events_id_seq from anon;
grant usage on sequence public.user_place_events_id_seq to authenticated;

drop policy if exists user_place_events_select_own on public.user_place_events;
drop policy if exists user_place_events_insert_own on public.user_place_events;
drop policy if exists user_place_events_delete_own on public.user_place_events;

create policy user_place_events_select_own on public.user_place_events for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and coalesce(((select auth.jwt())->>'is_anonymous')::boolean, false) is false
  );

create policy user_place_events_insert_own on public.user_place_events for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and coalesce(((select auth.jwt())->>'is_anonymous')::boolean, false) is false
  );

create policy user_place_events_delete_own on public.user_place_events for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and coalesce(((select auth.jwt())->>'is_anonymous')::boolean, false) is false
  );
