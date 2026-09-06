-- Sharing always creates or reuses a Supabase session before calling these
-- helpers. Anonymous riders therefore use the authenticated Postgres role;
-- the unauthenticated Data API role has no reason to execute SECURITY DEFINER
-- functions that inspect membership or join a trip.
revoke all on function public.is_trip_member(uuid) from public, anon;
grant execute on function public.is_trip_member(uuid) to authenticated, service_role;

revoke all on function public.join_trip(text, text) from public, anon;
grant execute on function public.join_trip(text, text) to authenticated, service_role;
