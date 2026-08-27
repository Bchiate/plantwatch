-- ─────────────────────────────────────────────────────────────
-- PlantWatch read-only garden sharing.
-- "Someone else watches my plants while I'm away."
--
-- One row = one invitation, which becomes one live share the moment the
-- invited person claims it with their OWN account (own email + password).
-- The guest never gets the owner's credentials and never gets a second
-- identity — they sign up normally, then bind their user id to this row.
--
-- Deliberately ADDITIVE AND INERT. This migration creates one new table and
-- nothing else. It does NOT touch profiles / ecowitt_accounts / zones /
-- gateways / plants / user_prefs / species_profiles, adds no policy to them,
-- and changes no grant on them. Nothing an existing client does — the web
-- PWA, an already-shipped iOS binary, the admin dashboard, report-v2,
-- ecowitt-devices — can observe any difference after this runs.
--
-- Guest reads are served exclusively by a service-role edge function
-- (`guest-report`). Guests never query the owner's tables directly, so no
-- permissive RLS policy is added anywhere. See the RLS note at the bottom.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.garden_shares (
  id              uuid primary key default gen_random_uuid(),

  -- Whose garden is being shared.
  owner_id        uuid        not null references auth.users(id) on delete cascade,

  -- Who it was offered to. The invitee may not have an account yet, so this
  -- is the only identifier we have at invite time. Stored normalised
  -- (lower + trimmed) so matching at claim time is exact, never fuzzy.
  invitee_email   text        not null,

  -- Set only when the invite is claimed by a signed-in account. Null = the
  -- invitation is still outstanding.
  guest_id        uuid        references auth.users(id) on delete cascade,

  -- What the guest may do. 'viewer' = read-only dashboard, which is all that
  -- is implemented. 'caretaker' is reserved for a later "can log a watering"
  -- role; the edge function keeps an explicit capability allowlist and denies
  -- any role it does not recognise, so an unimplemented role grants nothing.
  role            text        not null default 'viewer',

  -- Invite secret. Only the SHA-256 hex digest is stored, never the token
  -- itself, so a database dump does not hand out working invite links.
  -- Cleared on claim, which makes every invite link single-use.
  token_hash      text,

  -- Lifecycle. A vacation has an end date, so expiry is mandatory rather
  -- than optional — a share cannot be created that lives forever by default.
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  revoked_at      timestamptz,   -- soft revoke: keeps the audit trail

  -- Owner-facing extras.
  label           text,          -- e.g. 'Brother — Aug vacation'
  last_viewed_at  timestamptz,   -- "he checked in this morning"
  view_count      int         not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),   -- maintained by the edge function

  -- Normalised, minimally-sane address.
  constraint garden_shares_email_normalised
    check (invitee_email = lower(btrim(invitee_email)) and position('@' in invitee_email) > 1),
  -- Only roles the reader knows about can ever be stored.
  constraint garden_shares_role_known
    check (role in ('viewer', 'caretaker')),
  -- A stored digest is always a SHA-256 hex digest.
  constraint garden_shares_token_shape
    check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  -- You cannot share your garden with yourself.
  constraint garden_shares_not_self
    check (guest_id is null or guest_id <> owner_id),
  -- "Claimed" means exactly one thing: bound to a real account.
  constraint garden_shares_accept_pairs
    check ((guest_id is null) = (accepted_at is null)),
  -- An unclaimed invitation must still have a usable token.
  constraint garden_shares_token_required
    check (accepted_at is not null or token_hash is not null),
  constraint garden_shares_expiry_sane
    check (expires_at > created_at)
);

-- Hot path: "which gardens may this signed-in guest read?" Evaluated on
-- every guest dashboard load.
create index if not exists garden_shares_guest_live_idx
  on public.garden_shares (guest_id, expires_at desc)
  where guest_id is not null and revoked_at is null;

-- Owner's "who can see my garden" list.
create index if not exists garden_shares_owner_idx
  on public.garden_shares (owner_id, created_at desc);

-- Claim lookup by invite token.
create unique index if not exists garden_shares_token_hash_uidx
  on public.garden_shares (token_hash)
  where token_hash is not null;

-- At most one live invitation per (owner, invited address). Re-inviting the
-- same person UPDATEs this row — rotate token_hash, push out expires_at,
-- clear revoked_at — rather than inserting a competing second row. (An
-- expired-but-unrevoked row still occupies the slot, which is intentional:
-- the re-invite path must find and refresh it.)
create unique index if not exists garden_shares_owner_email_live_uidx
  on public.garden_shares (owner_id, invitee_email)
  where revoked_at is null;

-- ...and at most one live share per (owner, claimed guest), even if the same
-- person was invited at two different addresses.
create unique index if not exists garden_shares_owner_guest_live_uidx
  on public.garden_shares (owner_id, guest_id)
  where guest_id is not null and revoked_at is null;

-- ── Row-level security ───────────────────────────────────────
-- Same posture as plantwatch_soil_readings: no client session ever reads or
-- writes this table — only the edge functions (service role) do.
--
-- RLS is ON with NO policies, which denies every non-service role outright.
-- That is deliberately stronger than an owner_all policy: if a future broad
-- `grant ... on all tables in schema public to authenticated` is ever run by
-- hand, or Supabase's default privileges re-grant the table, the table still
-- reads as empty for anon/authenticated instead of leaking. token_hash in
-- particular must never be reachable from a client.
alter table public.garden_shares enable row level security;

-- Supabase's ALTER DEFAULT PRIVILEGES grants new public-schema tables to
-- anon/authenticated at creation time, so this revoke is required, not
-- decorative. Service role bypasses RLS but still needs the table privilege.
revoke all on public.garden_shares from anon, authenticated;
grant  all on public.garden_shares to service_role;
