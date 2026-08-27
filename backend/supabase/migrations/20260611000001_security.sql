-- Security hardening + schema catch-up (applied to production 2026-06-11).
-- Idempotent: safe to re-run.

-- 1) Dashboard title per account (was added live; recorded here so repo == prod).
alter table public.profiles add column if not exists garden_name text;

-- 2) SEC-1 — prevent privilege escalation & profile tampering.
--    The owner_all RLS policy only checks row ownership (id = auth.uid()), so a
--    signed-in user could PATCH their OWN row's is_admin/garden_name. Lock the
--    table down to column level: customers may update ONLY `onboarded` (the sole
--    column the apps write). is_admin / garden_name / email are service-role only.
revoke update on public.profiles from anon, authenticated;
grant  update (onboarded) on public.profiles to authenticated;

-- Edge functions use the service_role key, which bypasses these grants, so admin
-- provisioning (set is_admin, garden_name) continues to work server-side.
