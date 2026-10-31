-- SEC-M-3: reduce kv_store grants for `authenticated` to least privilege.
-- Review v2 M-4 (prelim M-1): prod had GRANT ALL ON kv_store TO authenticated,
-- which includes TRUNCATE, TRIGGER, REFERENCES, MAINTAIN. TRUNCATE is NOT subject
-- to RLS, so an allowlist-less authenticated user could (given any future direct
-- path) wipe the table. The app only ever does SELECT/INSERT/UPDATE/DELETE.
--
-- Revoke everything then regrant exactly the four the app needs. Idempotent and
-- future-proof (also drops any privilege not listed here, e.g. MAINTAIN on PG17).
-- service_role is intentionally left unchanged (server-only, bypasses RLS).

revoke all on table public.kv_store from authenticated;
grant select, insert, update, delete on table public.kv_store to authenticated;
