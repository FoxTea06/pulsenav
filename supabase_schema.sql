-- ============================================================================
-- PulseNav — Supabase PostgreSQL Schema, RLS Policies & Realtime Publication
-- Run this script in your Supabase Dashboard -> SQL Editor
-- ============================================================================

-- 1. CONVOYS TABLE (Stores shared leader route, destination & quick pings)
create table if not exists public.convoys (
  code text primary key check (code ~ '^[A-Z0-9]{6}$'),
  leader_id text not null,
  leader_name text not null,
  status text not null default 'idle' check (status in ('idle', 'routing', 'navigating')),
  destination jsonb,
  active_route jsonb,
  latest_ping jsonb,
  created_at bigint not null,
  updated_at bigint not null
);

-- 2. CONVOY MEMBERS TABLE (Stores live driver GPS telemetry per convoy)
create table if not exists public.convoy_members (
  convoy_code text not null references public.convoys(code) on delete cascade,
  id text not null,
  name text not null,
  color text not null,
  role text not null check (role in ('leader', 'member')),
  lat double precision not null check (lat >= -90 and lat <= 90),
  lng double precision not null check (lng >= -180 and lng <= 180),
  heading double precision not null default 0,
  speed_kmh double precision not null default 0,
  updated_at bigint not null,
  primary key (convoy_code, id)
);

-- 3. COMMUNITY REPORTS TABLE (Stores live road hazards, traffic & police alerts)
create table if not exists public.community_reports (
  id text primary key,
  category text not null check (category in ('traffic', 'accident', 'police', 'hazard')),
  subtype text not null,
  street text not null,
  note text,
  lat double precision not null check (lat >= -90 and lat <= 90),
  lng double precision not null check (lng >= -180 and lng <= 180),
  created_at bigint not null,
  expires_at bigint not null,
  upvotes integer not null default 1,
  reporter text not null default 'Driver'
);

-- ============================================================================
-- GRANT PRIVILEGES TO ANON / AUTHENTICATED ROLES
-- ============================================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table public.convoys to anon, authenticated;
grant select, insert, update, delete on table public.convoy_members to anon, authenticated;
grant select, insert, update, delete on table public.community_reports to anon, authenticated;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES FOR ANON / PUBLIC CLIENT ACCESS
-- ============================================================================
alter table public.convoys enable row level security;
alter table public.convoy_members enable row level security;
alter table public.community_reports enable row level security;

-- Convoys Policies
drop policy if exists "Allow public read convoys" on public.convoys;
create policy "Allow public read convoys"
  on public.convoys for select using (true);

drop policy if exists "Allow public insert convoys" on public.convoys;
create policy "Allow public insert convoys"
  on public.convoys for insert with check (true);

drop policy if exists "Allow public update convoys" on public.convoys;
create policy "Allow public update convoys"
  on public.convoys for update using (true);

-- Convoy Members Policies
drop policy if exists "Allow public read convoy_members" on public.convoy_members;
create policy "Allow public read convoy_members"
  on public.convoy_members for select using (true);

drop policy if exists "Allow public upsert convoy_members" on public.convoy_members;
create policy "Allow public upsert convoy_members"
  on public.convoy_members for insert with check (true);

drop policy if exists "Allow public update convoy_members" on public.convoy_members;
create policy "Allow public update convoy_members"
  on public.convoy_members for update using (true);

drop policy if exists "Allow public delete convoy_members" on public.convoy_members;
create policy "Allow public delete convoy_members"
  on public.convoy_members for delete using (true);

-- Community Reports Policies
drop policy if exists "Allow public read community_reports" on public.community_reports;
create policy "Allow public read community_reports"
  on public.community_reports for select using (true);

drop policy if exists "Allow public insert community_reports" on public.community_reports;
create policy "Allow public insert community_reports"
  on public.community_reports for insert with check (true);

drop policy if exists "Allow public update community_reports" on public.community_reports;
create policy "Allow public update community_reports"
  on public.community_reports for update using (true);

drop policy if exists "Allow public delete community_reports" on public.community_reports;
create policy "Allow public delete community_reports"
  on public.community_reports for delete using (true);

-- ============================================================================
-- ENABLE SUPABASE REALTIME REPLICATION
-- ============================================================================
alter publication supabase_realtime add table public.convoys;
alter publication supabase_realtime add table public.convoy_members;
alter publication supabase_realtime add table public.community_reports;

