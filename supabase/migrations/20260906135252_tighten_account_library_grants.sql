-- Supabase's legacy default privileges auto-granted every table privilege when
-- user_trips was created. The app only needs CRUD through the Data API.
revoke all on table public.user_trips from authenticated;
grant select, insert, update, delete on table public.user_trips to authenticated;
revoke all on table public.user_trips from anon;
