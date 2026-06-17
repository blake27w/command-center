-- Command Center — Supabase schema (Phase 1)
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- This script is IDEMPOTENT and NON-DESTRUCTIVE: every statement is safe to
-- re-run, and it never drops tables or deletes data. If you need a clean reset
-- (e.g. you pasted the wrong thing into a brand-new project with no real data),
-- run these three lines FIRST, on their own, then run this file:
--     drop table if exists tasks cascade;
--     drop table if exists projects cascade;
--     drop function if exists touch_updated_at() cascade;

-- ---------------------------------------------------------------------------
-- projects: the seven ventures. Shared config for the single owner.
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id text primary key,
  name text not null,
  color text not null,
  tag text default '',
  sort int default 0,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- tasks: every task across every venture.
--   status: todo | doing | done | suggested
--   source: manual | claude | agent
--   priority: high | med | low
-- ---------------------------------------------------------------------------
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  owner uuid references auth.users not null default auth.uid(),
  project_id text references projects(id) on delete cascade,
  title text not null,
  note text default '',
  priority text not null default 'med',          -- high | med | low
  status text not null default 'todo',            -- todo | doing | done | suggested
  source text not null default 'manual',          -- manual | claude | agent
  due date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security — single-user model. (enable is a no-op if already on)
-- ---------------------------------------------------------------------------
alter table projects enable row level security;
alter table tasks enable row level security;

-- Each task row is owned; only the owner can read/write it.
drop policy if exists "own tasks" on tasks;
create policy "own tasks" on tasks for all
  using (auth.uid() = owner) with check (auth.uid() = owner);

-- Projects are shared config for the one user; any authenticated user (it's just
-- Blake) can read/write them.
drop policy if exists "authed projects" on projects;
create policy "authed projects" on projects for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- keep updated_at fresh on every task update
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- table exists by now, so dropping the trigger is safe even on a re-run
drop trigger if exists tasks_touch on tasks;
create trigger tasks_touch before update on tasks
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Seed the seven ventures (upsert — re-running won't duplicate).
-- ---------------------------------------------------------------------------
insert into projects (id, name, color, tag, sort) values
  ('alpha',  'Alpha Radar',              '#80332E', '',     0),
  ('vantyx', 'Vantyx Business Solutions','#C0792A', '',     1),
  ('land',   'Landscape & Junk Removal', '#4F6B3E', '',     2),
  ('tcb',    'Three Chord Bourbon',      '#B0863A', '',     3),
  ('edge',   'Edge Tracker',             '#3E5A6B', '',     4),
  ('pool',   'Pool Hall Pro',            '#6B4F8C', 'thin', 5),
  ('scout',  'Scout',                    '#8C846F', 'thin', 6)
on conflict (id) do update
  set name = excluded.name, color = excluded.color, tag = excluded.tag, sort = excluded.sort;

-- ---------------------------------------------------------------------------
-- Enable Realtime on `tasks` (guarded so re-running won't error if already on).
-- Dashboard equivalent: Database → Replication → supabase_realtime → toggle tasks.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table tasks;
  end if;
end $$;
