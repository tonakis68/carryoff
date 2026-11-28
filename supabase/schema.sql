-- CarryOff database schema (stage 1).
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run again: every statement is "if not exists".
--
-- PRIVACY MODEL
-- Row Level Security (RLS) is switched on for every table and there are NO
-- policies. That means the public "anon" key can read and write nothing.
-- Only the server code (Cloudflare Functions) can touch data, using the secret
-- key, which is never sent to the browser.

create table if not exists partners (
  id          text primary key,                 -- slug, e.g. 'mosaic'
  name        text not null,
  email       text not null check (email = lower(email)),   -- always lowercase
  phone       text,
  address     text,
  active      boolean not null default true,    -- false = cannot log in
  paused      boolean not null default false,   -- true = not taking new bookings
  created_at  timestamptz not null default now()
);
create unique index if not exists partners_email_key on partners (lower(email));

create table if not exists partner_applications (
  id          uuid primary key default gen_random_uuid(),
  ref         text not null unique,
  name        text not null,
  eik         text,
  type        text,
  address     text not null,
  contact     text not null,
  phone       text not null,
  email       text not null,
  cap_pack    int  not null default 0,
  cap_med     int  not null default 0,
  cap_large   int  not null default 0,
  opens       text,
  closes      text,
  days        int[] not null default '{}',
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at  timestamptz not null default now()
);

-- One-time login codes (stored hashed, never in clear text).
create table if not exists login_codes (
  id          uuid primary key default gen_random_uuid(),
  role        text not null check (role in ('partner','owner')),
  email       text not null,
  code_hash   text not null,
  attempts    int  not null default 0,
  used        boolean not null default false,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists login_codes_lookup on login_codes (role, email, created_at desc);

-- Owner two-step login (Google Authenticator style). Exactly one row, id = 1.
create table if not exists owner_settings (
  id                int primary key default 1 check (id = 1),
  totp_secret       text,
  totp_enabled      boolean not null default false,
  totp_fails        int not null default 0,
  totp_locked_until timestamptz
);

-- Every email we try to send. Used for the daily-limit warning and for debugging.
create table if not exists email_log (
  id          bigint generated always as identity primary key,
  to_email    text not null,
  kind        text not null,
  status      text not null check (status in ('sent','failed','blocked')),
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists email_log_day on email_log (created_at desc);

-- Used from stage 2 (payments). Created now so the schema is done once.
create table if not exists bookings (
  id                 uuid primary key default gen_random_uuid(),
  ref                text not null unique,            -- e.g. CO-4HN8T
  partner_id         text not null references partners(id),
  customer_name      text not null,
  customer_email     text not null,
  customer_phone     text not null,
  drop_date          date not null,
  drop_time          text not null,
  pick_date          date not null,
  pick_time          text not null,
  n_pack             int not null default 0 check (n_pack >= 0),
  n_med              int not null default 0 check (n_med >= 0),
  n_large            int not null default 0 check (n_large >= 0),
  total_cents        int not null check (total_cents >= 0),
  status             text not null default 'pending_payment'
                     check (status in ('pending_payment','booked','stored','returned','refused','cancelled')),
  stripe_session_id  text unique,
  paid_at            timestamptz,
  tags               text[],
  photo_path         text,
  stored_at          timestamptz,
  returned_at        timestamptz,
  created_at         timestamptz not null default now(),
  check (pick_date = drop_date)                        -- same-day storage only
);
create index if not exists bookings_partner_day on bookings (partner_id, drop_date);

-- Monthly payout record per partner (stage 3).
create table if not exists payouts (
  id            uuid primary key default gen_random_uuid(),
  partner_id    text not null references partners(id),
  month         text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  bags          int  not null default 0,
  amount_cents  int  not null default 0,
  status        text not null default 'open' check (status in ('open','paid')),
  paid_at       timestamptz,
  unique (partner_id, month)
);

-- Lock everything down.
alter table partners              enable row level security;
alter table partner_applications  enable row level security;
alter table login_codes           enable row level security;
alter table owner_settings        enable row level security;
alter table email_log             enable row level security;
alter table bookings              enable row level security;
alter table payouts               enable row level security;

revoke all on partners, partner_applications, login_codes, owner_settings,
              email_log, bookings, payouts from anon, authenticated;

-- The server (service_role) needs explicit access, because Supabase does not
-- grant it automatically when "Grant API access to new tables" is off.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- Added later: company ID (ЕИК) on partner applications
alter table partner_applications add column if not exists eik text;
alter table partner_applications add column if not exists reg_address text, add column if not exists rep_name text, add column if not exists rep_position text, add column if not exists vat text;
alter table partner_applications add column if not exists bfrom text, add column if not exists bto text;
alter table partner_applications add column if not exists hours jsonb;
