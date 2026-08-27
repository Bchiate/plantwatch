-- User-defined custom plant types (in addition to the built-in catalog).
-- A plant's species can reference a built-in key (resolved in code) or a custom
-- key resolved from this table at report time.
create table if not exists public.species_profiles (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  key         text not null,                                  -- e.g. 'custom_tomato'
  label       text not null,                                  -- 'Tomato'
  ideal_low   int  not null check (ideal_low  between 0 and 100),
  ideal_high  int  not null check (ideal_high between 0 and 100),
  why         text,
  size        text not null default 'medium',                 -- small|medium|large (watering volume)
  created_at  timestamptz not null default now(),
  unique (user_id, key)
);
alter table public.species_profiles enable row level security;
drop policy if exists owner_all on public.species_profiles;
create policy owner_all on public.species_profiles using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.species_profiles to authenticated;
