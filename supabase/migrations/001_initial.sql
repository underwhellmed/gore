-- ============================================================================
-- Discord Bot — Initial Schema
-- ============================================================================
-- Design principles:
--   1. Service role is the ONLY actor. There is no dashboard, no client.
--      Every table is RLS-enabled with NO anon/authenticated policies —
--      default-deny for everything except service_role (which bypasses RLS).
--   2. Denormalized Discord IDs (guild_id, user_id) are TEXT, not FKs to
--      Discord. Discord has no FK concept. The application validates format.
--   3. Partial unique indexes enforce "one active entitlement per owner".
--   4. updated_at auto-maintained via trigger on mutable tables.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extensions
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto";      -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Enum types (guarded — safe to re-run)
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'premium_type') then
    create type premium_type as enum ('server', 'user');
  end if;
  if not exists (select 1 from pg_type where typname = 'entitlement_status') then
    create type entitlement_status as enum ('active', 'revoked', 'expired');
  end if;
  if not exists (select 1 from pg_type where typname = 'ticket_status') then
    create type ticket_status as enum ('open', 'closed', 'archived');
  end if;
end $$;

-- ============================================================================
-- TABLE: bot_admins
-- ============================================================================
-- The security boundary for every `*` prefix command. A row here means
-- "this Discord user can execute bot-admin commands". The `active` flag
-- allows revocation without deleting the historical record.
-- ============================================================================
create table if not exists bot_admins (
  discord_user_id text primary key,
  granted_by      text        not null,
  granted_at      timestamptz not null default now(),
  active          boolean     not null default true
);

comment on table bot_admins is
  'Discord users authorized to run * prefix commands. Managed out-of-band.';

-- ============================================================================
-- TABLE: guild_admins
-- ============================================================================
-- Cached list of administrators per guild. Refreshed on guild join,
-- on *sync-guild-admins, and (optionally) on a schedule.
-- NOT a security boundary on its own — the gate in commandHandler also
-- accepts live Discord Administrator permission, so a fresh admin can
-- act immediately without waiting for the next sync.
-- ============================================================================
create table if not exists guild_admins (
  guild_id text not null,
  user_id  text not null,
  primary key (guild_id, user_id)
);

comment on table guild_admins is
  'Cached guild administrators. Synced from Discord. Not a hard boundary.';

-- ============================================================================
-- TABLE: entitlements
-- ============================================================================
-- Source of truth for premium ownership. Every premium check in the bot
-- calls entitlementService, which reads this table. There is no cache.
--
-- Partial unique index on (premium_type, owner_id) WHERE status='active'
-- enforces "one active entitlement per owner per type" at the DB level —
-- the application also pre-checks, but the DB is the final guarantee.
-- ============================================================================
create table if not exists entitlements (
  entitlement_id    uuid primary key default gen_random_uuid(),
  premium_type      premium_type       not null,
  owner_id          text               not null,
  status            entitlement_status not null default 'active',
  granted_by        text               not null,
  granted_at        timestamptz        not null default now(),
  revoked_at        timestamptz,
  revoked_by        text,
  payment_reference text,
  grant_reason      text,
  revoke_reason     text,

  -- Cannot revoke without recording who and when
  constraint entitlements_revoke_consistency check (
    (status = 'revoked' and revoked_at is not null and revoked_by is not null)
    or (status <> 'revoked')
  )
);

comment on table entitlements is
  'Source of truth for premium ownership. Read by entitlementService only.';

create unique index if not exists idx_entitlements_active_unique
  on entitlements (premium_type, owner_id)
  where status = 'active';

create index if not exists idx_entitlements_owner
  on entitlements (owner_id);

create index if not exists idx_entitlements_status
  on entitlements (status);

create index if not exists idx_entitlements_granted_at
  on entitlements (granted_at desc);

-- ============================================================================
-- TABLE: guild_configs
-- ============================================================================
-- Per-guild configuration. One row per guild. Columns are split between
-- first-class (frequently queried) and JSONB `automations` (rarely queried,
-- extended without migration).
-- ============================================================================
create table if not exists guild_configs (
  guild_id              text primary key,

  -- Tickets
  ticket_category_id    text,
  ticket_log_channel_id text,
  ticket_staff_role_id  text,

  -- Welcome
  welcome_channel_id    text,
  welcome_message       text,

  -- Logging
  log_channel_id        text,

  -- Feature flags
  leveling_enabled      boolean not null default false,
  giveaways_enabled     boolean not null default false,

  -- Extensible settings (log_events, level_up_channel_id, xp_multiplier, ...)
  automations           jsonb   not null default '{}'::jsonb,

  -- Reserved for future per-guild bot presentation (not currently written)
  premium_customization jsonb   not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table guild_configs is
  'Per-guild configuration. One row per guild, upserted by config commands.';

create index if not exists idx_guild_configs_updated_at
  on guild_configs (updated_at desc);

-- Auto-maintain updated_at
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_guild_configs_updated_at on guild_configs;
create trigger trg_guild_configs_updated_at
  before update on guild_configs
  for each row execute function set_updated_at();

-- ============================================================================
-- TABLE: premium_customizations
-- ============================================================================
-- Per-guild premium visual customization. The FK to guild_configs is
-- intentionally omitted: a guild may configure premium embeds before any
-- other config command has run, and requiring guild_configs to exist first
-- would be a footgun. Both tables are keyed by Discord guild_id and
-- cross-checked at the application layer.
-- ============================================================================
create table if not exists premium_customizations (
  guild_id       text primary key,
  bot_avatar_url text,
  bot_banner_url text,
  bot_bio        text,
  custom_embeds  jsonb not null default '{}'::jsonb,
  custom_presence jsonb
);

comment on table premium_customizations is
  'Per-guild premium customization. custom_embeds keys: color, footer, thumbnail.';

-- ============================================================================
-- TABLE: tickets
-- ============================================================================
create table if not exists tickets (
  ticket_id      uuid primary key default gen_random_uuid(),
  guild_id       text not null,
  channel_id     text not null unique,
  owner_id       text not null,
  status         ticket_status not null default 'open',
  category       text,
  claimed_by     text,
  created_at     timestamptz not null default now(),
  closed_at      timestamptz,
  transcript_url text,

  constraint tickets_closed_consistency check (
    (status = 'closed' and closed_at is not null)
    or (status <> 'closed')
  )
);

comment on table tickets is
  'Ticket records. channel_id is unique — one row per ticket channel.';

create index if not exists idx_tickets_guild_status
  on tickets (guild_id, status);

create index if not exists idx_tickets_owner_status
  on tickets (guild_id, owner_id, status);

create index if not exists idx_tickets_created_at
  on tickets (created_at desc);

-- ============================================================================
-- TABLE: admin_audit_log
-- ============================================================================
-- Append-only. Every bot-admin action that changes global state writes here.
-- ============================================================================
create table if not exists admin_audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   text not null,
  action     text not null,
  target_id  text,
  details    jsonb,
  created_at timestamptz not null default now()
);

comment on table admin_audit_log is
  'Append-only log of bot-admin actions. Written by auditService.';

create index if not exists idx_audit_created_at
  on admin_audit_log (created_at desc);

create index if not exists idx_audit_target
  on admin_audit_log (target_id, created_at desc);

create index if not exists idx_audit_actor
  on admin_audit_log (actor_id, created_at desc);

-- ============================================================================
-- TABLE: levels
-- ============================================================================
create table if not exists levels (
  guild_id text    not null,
  user_id  text    not null,
  xp       integer not null default 0,
  level    integer not null default 0,
  primary key (guild_id, user_id),

  constraint levels_xp_nonneg  check (xp >= 0),
  constraint levels_lvl_nonneg check (level >= 0)
);

comment on table levels is
  'Per-guild XP and level per user. Cooldown enforced in-memory by awardMessageXp.';

-- Leaderboard sort: level DESC, xp DESC within a guild
create index if not exists idx_levels_leaderboard
  on levels (guild_id, level desc, xp desc);

-- ============================================================================
-- TABLE: warnings
-- ============================================================================
create table if not exists warnings (
  id           uuid primary key default gen_random_uuid(),
  guild_id     text not null,
  user_id      text not null,
  moderator_id text not null,
  reason       text,
  created_at   timestamptz not null default now()
);

comment on table warnings is
  'Warning records. *warns reads, *clearwarns deletes by id or all.';

create index if not exists idx_warnings_guild_user
  on warnings (guild_id, user_id, created_at desc);

-- ============================================================================
-- TABLE: giveaways
-- ============================================================================
create table if not exists giveaways (
  id         uuid primary key default gen_random_uuid(),
  guild_id   text    not null,
  channel_id text    not null,
  message_id text    not null,
  prize      text    not null,
  ends_at    timestamptz not null,
  winners    integer not null default 1,
  ended      boolean not null default false,
  created_by text    not null,
  created_at timestamptz not null default now(),

  constraint giveaways_winners_positive check (winners >= 1)
);

comment on table giveaways is
  'Giveaway records. Polled every 30s for expired, non-ended rows.';

-- Poll loop query: ended=false AND ends_at < now()
create index if not exists idx_giveaways_pending
  on giveaways (ended, ends_at)
  where ended = false;

create index if not exists idx_giveaways_guild_message
  on giveaways (guild_id, message_id);

-- ============================================================================
-- ROW-LEVEL SECURITY
-- ============================================================================
-- Every table is RLS-enabled. There are NO policies granting anon or
-- authenticated access — default-deny for every non-service role.
--
-- The bot uses the service_role key, which BYPASSES RLS. So technically
-- no policies are needed for the bot to function. But enabling RLS with
-- no permissive policies guarantees that even if the anon key leaks
-- (it won't — there is no client), nothing is accessible.
--
-- This is the correct posture for a bot-only deployment with no dashboard.
-- ============================================================================

alter table bot_admins            enable row level security;
alter table guild_admins          enable row level security;
alter table entitlements          enable row level security;
alter table guild_configs         enable row level security;
alter table premium_customizations enable row level security;
alter table tickets               enable row level security;
alter table admin_audit_log       enable row level security;
alter table levels                enable row level security;
alter table warnings              enable row level security;
alter table giveaways             enable row level security;

-- Explicit service_role policies for documentation. These are technically
-- redundant (service_role bypasses RLS) but make intent unambiguous and
-- protect against accidental future changes to the service_role config.

drop policy if exists "service_role_all" on bot_admins;
create policy "service_role_all" on bot_admins
  for all using (auth.role() = 'service_role');

drop policy if exists "service_role_all" on guild_admins;
create policy "service_role_all" on guild_admins
  for all using (auth.role() = 'service_role');

drop policy if exists "service_role_all" on entitlements;
create policy "service_role_all" on entitlements
  for all using (auth.role() = 'service_role');

drop policy if exists "service_role_all" on guild_configs;
create policy "service_role_all" on guild_configs
  for all using (auth.role() = 'service_role');

drop policy if exists "service_role_all" on premium_customizations;
create policy "service_role_all" on premium_customizations
  for all using (auth.role() = 'service_role');

drop policy if exists "service_role_all" on tickets;
create policy "service_role_all" on tickets
  for all using (auth.role() = 'service_role');

drop policy if exists "service_role_all" on admin_audit_log;
create policy "service_role_all" on admin_audit_log
  for all using (auth.role() = 'service_role');

drop policy if exists "service_role_all" on levels;
create policy "service_role_all" on levels
  for all using (auth.role() = 'service_role');

drop policy if exists "service_role_all" on warnings;
create policy "service_role_all" on warnings
  for all using (auth.role() = 'service_role');

drop policy if exists "service_role_all" on giveaways;
create policy "service_role_all" on giveaways
  for all using (auth.role() = 'service_role');

-- ============================================================================
-- STORAGE: transcripts bucket
-- ============================================================================
-- Private bucket for HTML ticket transcripts. The bot uploads and generates
-- signed URLs via service_role — both bypass storage RLS. The bucket being
-- private means no direct public URL exists; only signed URLs work, and
-- they expire (default 1h).
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('transcripts', 'transcripts', false)
on conflict (id) do update set public = false;

-- Belt-and-suspenders: explicitly deny anon/authenticated reads on the
-- bucket. Because there is no client, this is redundant — but it's the
-- correct posture if a dashboard is ever added.
drop policy if exists "service_role_storage_all" on storage.objects;
create policy "service_role_storage_all" on storage.objects
  for all
  using (
    bucket_id = 'transcripts'
    and auth.role() = 'service_role'
  )
  with check (
    bucket_id = 'transcripts'
    and auth.role() = 'service_role'
  );

-- ============================================================================
-- SEED INSTRUCTIONS (run once, manually, after this migration)
-- ============================================================================
-- Replace <YOUR_DISCORD_USER_ID> with your actual snowflake ID
-- (Discord → User Settings → Advanced → Developer Mode → right-click yourself).
--
-- insert into bot_admins (discord_user_id, granted_by)
-- values ('<YOUR_DISCORD_USER_ID>', '<YOUR_DISCORD_USER_ID>');
--
-- Then, once you've added the bot to your first server:
--
-- insert into guild_admins (guild_id, user_id)
-- values ('<YOUR_GUILD_ID>', '<YOUR_DISCORD_USER_ID>');
--
-- (The guildCreate event will do this automatically. The manual insert
-- above is only needed if you want to bootstrap before the bot has been
-- added to any server.)
