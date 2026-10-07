-- Core tables for the HubSpot <-> Supabase order sync (ARCHITECTURE §2).
-- Fernhill Supply Co. is fictional; all data is synthetic.

create schema if not exists private;

-- ---------------------------------------------------------------- customers
create table public.customers (
  id                 uuid primary key default gen_random_uuid(),
  hubspot_contact_id bigint unique,
  email              text,
  first_name         text,
  last_name          text,
  phone              text,
  lifecycle_stage    text,
  hs_last_modified   timestamptz,
  updated_by         text not null check (updated_by in ('hubspot', 'app')),
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- Emails are compared case-insensitively; null after a HubSpot delete, so many nulls are fine.
create unique index customers_email_key on public.customers (lower(email));

-- ------------------------------------------------------------------- orders
create table public.orders (
  id           uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id  uuid not null references public.customers (id) on delete restrict,
  ordered_at   timestamptz not null,
  total_cents  integer not null check (total_cents >= 0),
  currency     char(3) not null default 'USD',
  status       text not null check (status in ('processing', 'shipped', 'delivered', 'cancelled')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index orders_customer_recent on public.orders (customer_id, ordered_at desc);

-- ------------------------------------------------------------------- queues
-- Status flow: pending -> processing -> done | skipped | failed -> ... -> dead (terminal).
create table public.sync_inbox (
  id              bigint generated always as identity primary key,
  dedupe_key      text not null unique,
  payload         jsonb not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'processing', 'done', 'skipped', 'failed', 'dead')),
  attempts        integer not null default 0,
  claimed_at      timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);
create index sync_inbox_due on public.sync_inbox (status, next_attempt_at);

create table public.sync_outbox (
  id              bigint generated always as identity primary key,
  kind            text not null check (kind in ('rollup', 'link_contact')),
  customer_id     uuid not null references public.customers (id) on delete cascade,
  status          text not null default 'pending'
                  check (status in ('pending', 'processing', 'done', 'skipped', 'failed', 'dead')),
  attempts        integer not null default 0,
  claimed_at      timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  processed_at    timestamptz
);
create index sync_outbox_due on public.sync_outbox (status, next_attempt_at);
-- At most one pending job per (kind, customer): bursts of order changes coalesce.
create unique index sync_outbox_one_pending
  on public.sync_outbox (kind, customer_id) where status = 'pending';

-- --------------------------------------------------------- form submissions
create table public.form_submissions (
  id                 bigint generated always as identity primary key,
  dedupe_key         text not null,
  email              text not null,
  status             text not null default 'processing' check (status in ('processing', 'done', 'failed')),
  claimed_at         timestamptz not null default now(),
  contact_done       boolean not null default false,
  deal_done          boolean not null default false,
  hubspot_contact_id bigint,
  hubspot_deal_id    bigint,
  last_error         text,
  created_at         timestamptz not null default now()
);
create index form_submissions_key_recent on public.form_submissions (dedupe_key, created_at desc);

-- -------------------------------------------------------------- rate limits
-- Per-IP buckets hold sha256(ip + salt), computed by the app; never a raw IP.
create table public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket, window_start)
);

-- ----------------------------------------------------------------- sync log
-- IDs and outcomes only, never names or emails (feeds the public /activity page).
create table public.sync_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  direction text not null check (direction in ('inbound', 'outbound', 'form', 'system')),
  object_id text,
  action    text not null,
  outcome   text not null
);
create index sync_log_recent on public.sync_log (at desc);

-- ----------------------------------------------------------- updated_at stamp
create function private.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger customers_touch before update on public.customers
  for each row execute function private.touch_updated_at();
create trigger orders_touch before update on public.orders
  for each row execute function private.touch_updated_at();

-- ------------------------------------------------------------------- access
-- RLS on, no policies: anon/authenticated see nothing. Only the server (service role) has access.
alter table public.customers        enable row level security;
alter table public.orders           enable row level security;
alter table public.sync_inbox       enable row level security;
alter table public.sync_outbox      enable row level security;
alter table public.form_submissions enable row level security;
alter table public.rate_limits      enable row level security;
alter table public.sync_log         enable row level security;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
revoke all on schema private from public, anon, authenticated;
