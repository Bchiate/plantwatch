-- Track real app activity for the admin dashboard's "last active" metric.
-- Updated by report-v2 (via service role) on each report load, so it reflects
-- actual usage rather than the stale GoTrue last_sign_in_at (persistent sessions
-- rarely trigger a fresh sign-in). Service-role-only write — can't be forged.
alter table public.profiles add column if not exists last_active_at timestamptz;
