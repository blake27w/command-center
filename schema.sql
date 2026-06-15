-- Command Center — Supabase schema (Phase 1)
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- After running, enable Realtime on `tasks` (Database → Replication, or add `tasks`
-- to the `supabase_realtime` publication — see the bottom of this file).

-- ---------------------------------------------------------------------------
-- projects: the seven ventures. Shared config for the single owner.
-- ---------------------------------------------------------------------------
create table projects (
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
create table tasks (
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
-- Row Level Security — single-user model.
-- ---------------------------------------------------------------------------
alter table projects enable row level security;
alter table tasks enable row level security;

-- Each task row is owned; only the owner can read/write it.
create policy "own tasks" on tasks for all
  using (auth.uid() = owner) with check (auth.uid() = owner);

-- Projects are shared config for the one user; any authenticated user (it's just
-- Blake) can read/write them.
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

create trigger tasks_touch before update on tasks
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Seed the seven ventures.
-- ---------------------------------------------------------------------------
insert into projects (id, name, color, tag, sort) values
  ('alpha',  'Alpha Radar',              '#80332E', '',       0),
  ('vantyx', 'Vantyx Business Solutions','#C0792A', '',       1),
  ('land',   'Landscape & Junk Removal', '#4F6B3E', '',       2),
  ('tcb',    'Three Chord Bourbon',      '#B0863A', '',       3),
  ('edge',   'Edge Tracker',             '#3E5A6B', '',       4),
  ('pool',   'Pool Hall Pro',            '#6B4F8C', 'thin',   5),
  ('scout',  'Scout',                    '#8C846F', 'thin',   6)
on conflict (id) do update
  set name = excluded.name, color = excluded.color, tag = excluded.tag, sort = excluded.sort;

-- ---------------------------------------------------------------------------
-- Enable Realtime on `tasks`.
-- The Supabase dashboard path is: Database → Replication → supabase_realtime →
-- toggle `tasks` on. If you prefer SQL, the equivalent is:
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table tasks;
