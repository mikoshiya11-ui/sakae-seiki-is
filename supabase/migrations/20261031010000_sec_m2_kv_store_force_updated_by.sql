-- SEC-M-2: force kv_store.updated_by = auth.uid() on the server.
-- Review v2 M-2 / SEC-U4-02: the client supplied updated_by (see _sakaeSync pushKey),
-- so an authorized user could store another user's id and frame them. The DB must
-- own this column, mirroring issue_cm_touch on the issue tables.
--
-- SECURITY INVOKER (like issue_cm_touch): auth.uid() reads the caller's JWT claim.
-- search_path '' so auth.uid() must be schema-qualified; no other refs.
-- Honest clients already send updated_by = their own uid, so this is a no-op for them.

create or replace function public.kv_store_force_updated_by()
  returns trigger
  language plpgsql
  set search_path to ''
as $$
begin
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

revoke all on function public.kv_store_force_updated_by() from public;
grant execute on function public.kv_store_force_updated_by() to anon, authenticated, service_role;

drop trigger if exists trg_kv_store_force_updated_by on public.kv_store;
-- BEFORE INSERT OR UPDATE: covers both write paths (the existing updated_at trigger is UPDATE-only).
create trigger trg_kv_store_force_updated_by
  before insert or update on public.kv_store
  for each row execute function public.kv_store_force_updated_by();
