-- ===========================================================================
-- Command Center — migration 002: shared workspace + device bus
--
-- Run this ONCE in the Supabase SQL editor (Dashboard -> SQL Editor -> New
-- query), AFTER schema.sql. Like schema.sql this script is IDEMPOTENT and
-- NON-DESTRUCTIVE: every statement is safe to re-run and none of them drop a
-- table or delete a row.
--
-- What it adds
--   1. project_members  — who can see which venture. Replaces the single-owner
--                         model so Brad can be given Vantyx and nothing else.
--   2. attribution      — created_by / updated_by on tasks, kept by trigger.
--   3. subtasks, task_comments, venture_notes, contacts, targets
--   4. recurrences      — repeating tasks the agent materialises
--   5. venture_settings — agent on/off + daily cap, editable from the app
--   6. devices, job_kinds, jobs — the Mac mini bus
--   7. activity + activity_reads — the feed behind the bell
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE YOU RUN IT
-- ---------------------------------------------------------------------------
-- Section 1.6 bootstraps project_members by granting EVERY EXISTING auth user
-- access to EVERY venture. Today that is exactly one person: you. That is what
-- keeps you from locking yourself out the moment the new policies take effect.
--
-- It is guarded to run ONCE — the first time, when project_members is empty —
-- and never again, so re-running this migration after Brad has an account will
-- not hand him the whole workspace.
--
-- Even so: RUN THIS BEFORE BRAD CREATES HIS ACCOUNT. If he signs in first, the
-- very first run grants him all nine ventures, and you would have to delete
-- those rows by hand. If he somehow already has an account, delete the seed in
-- section 1.6 before running and insert your own membership rows explicitly.
-- ===========================================================================


-- ===========================================================================
-- 1. MEMBERSHIP — who can see which venture
-- ===========================================================================

create table if not exists project_members (
  project_id text references projects(id) on delete cascade,
  user_id    uuid references auth.users on delete cascade,
  role       text not null default 'member',   -- owner | member
  created_at timestamptz default now(),
  primary key (project_id, user_id)
);

alter table project_members enable row level security;

-- 1.1  Helper: is the current user a member of this project?
--      SECURITY DEFINER so the function can read project_members without
--      recursing through the very policies that call it. Without this you get
--      "infinite recursion detected in policy" the first time you query tasks.
create or replace function is_member(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from project_members
    where project_id = p and user_id = auth.uid()
  );
$$;

create or replace function is_owner(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from project_members
    where project_id = p and user_id = auth.uid() and role = 'owner'
  );
$$;

-- 1.2  You can see your own membership rows, and every row for a venture you
--      own (so the app can list who else is on it).
drop policy if exists "read memberships" on project_members;
create policy "read memberships" on project_members for select
  using (user_id = auth.uid() or is_owner(project_id));

-- 1.3  Only an owner of the venture can add or remove people.
drop policy if exists "owners manage members" on project_members;
create policy "owners manage members" on project_members for all
  using (is_owner(project_id)) with check (is_owner(project_id));

-- 1.4  PROJECTS: you only see ventures you belong to. This is what makes
--      Brad's venture chip row show Vantyx alone.
drop policy if exists "authed projects" on projects;   -- the old single-user policy
drop policy if exists "member projects" on projects;
create policy "member projects" on projects for select using (is_member(id));

drop policy if exists "owner writes projects" on projects;
create policy "owner writes projects" on projects for all
  using (is_owner(id)) with check (is_owner(id));

-- 1.5  TASKS: visibility follows the venture, not the row's owner.
--      `owner` stays on the row — agent/run.js still stamps it, and it tells
--      you who a task belongs to — but it no longer gates who can read it.
drop policy if exists "own tasks" on tasks;
drop policy if exists "member tasks" on tasks;
create policy "member tasks" on tasks for all
  using (is_member(project_id)) with check (is_member(project_id));

-- 1.6  BOOTSTRAP SEED — runs exactly once, ever.
--
--      Grants every existing user every existing venture, so that the moment
--      the new policies take effect you still have access to your own data.
--
--      The `where not exists` guard is the important part. Without it, this
--      statement re-fires on every re-run of the migration — and once Brad has
--      an account, a re-run silently grants him all nine ventures. `on
--      conflict do nothing` hides that: no error, no warning, just a partner
--      who can suddenly read Three Chord Bourbon and your betting models.
--
--      Once project_members holds a single row the workspace is considered
--      bootstrapped and this never runs again. Add people explicitly after
--      that — see the footer of this file.
insert into project_members (project_id, user_id, role)
select p.id, u.id, 'owner'
from projects p cross join auth.users u
where not exists (select 1 from project_members)
on conflict (project_id, user_id) do nothing;


-- ===========================================================================
-- 2. ATTRIBUTION — who created a task, who touched it last
-- ===========================================================================

alter table tasks add column if not exists created_by uuid references auth.users;
alter table tasks add column if not exists updated_by uuid references auth.users;

-- Extend the existing touch_updated_at trigger rather than adding a second one.
-- coalesce(auth.uid(), owner) keeps agent inserts (service key, no auth.uid())
-- attributed to the venture owner instead of writing null.
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  new.updated_by = coalesce(auth.uid(), new.owner);
  return new;
end;
$$ language plpgsql;

create or replace function stamp_created_by() returns trigger as $$
begin
  new.created_by = coalesce(new.created_by, auth.uid(), new.owner);
  new.updated_by = coalesce(new.updated_by, auth.uid(), new.owner);
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_stamp on tasks;
create trigger tasks_stamp before insert on tasks
  for each row execute function stamp_created_by();

-- Backfill: existing rows get attributed to their owner.
update tasks set created_by = owner where created_by is null and owner is not null;
update tasks set updated_by = owner where updated_by is null and owner is not null;


-- ===========================================================================
-- 3. SUBTASKS — the checklist inside a task
-- ===========================================================================

create table if not exists subtasks (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid references tasks(id) on delete cascade not null,
  title      text not null,
  done       boolean not null default false,
  sort       int default 0,
  created_at timestamptz default now()
);
create index if not exists subtasks_task on subtasks(task_id);

alter table subtasks enable row level security;
drop policy if exists "member subtasks" on subtasks;
create policy "member subtasks" on subtasks for all
  using (exists (select 1 from tasks t where t.id = task_id and is_member(t.project_id)))
  with check (exists (select 1 from tasks t where t.id = task_id and is_member(t.project_id)));


-- ===========================================================================
-- 4. TASK COMMENTS — the back-and-forth, append-only by design
-- ===========================================================================

create table if not exists task_comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid references tasks(id) on delete cascade not null,
  author     uuid references auth.users not null default auth.uid(),
  body       text not null,
  created_at timestamptz default now()
);
create index if not exists task_comments_task on task_comments(task_id, created_at);

alter table task_comments enable row level security;

-- Anyone on the venture can read every comment...
drop policy if exists "member reads comments" on task_comments;
create policy "member reads comments" on task_comments for select
  using (exists (select 1 from tasks t where t.id = task_id and is_member(t.project_id)));

-- ...and write their own...
drop policy if exists "member writes comments" on task_comments;
create policy "member writes comments" on task_comments for insert
  with check (author = auth.uid()
    and exists (select 1 from tasks t where t.id = task_id and is_member(t.project_id)));

-- ...but nobody can edit or delete one. Deliberate: a thread you can quietly
-- rewrite is worthless as a record of what was agreed. There is no update or
-- delete policy here, so both are denied for every non-service caller.


-- ===========================================================================
-- 5. VENTURE NOTES — one running note per venture, editable by both
--    Versioned on every save: the note itself is a single current row, and
--    every previous body is kept in venture_note_versions. Cheap now,
--    impossible to add convincingly later.
-- ===========================================================================

create table if not exists venture_notes (
  project_id text primary key references projects(id) on delete cascade,
  body       text not null default '',
  updated_by uuid references auth.users,
  updated_at timestamptz default now()
);

create table if not exists venture_note_versions (
  id         uuid primary key default gen_random_uuid(),
  project_id text references projects(id) on delete cascade not null,
  body       text not null,
  author     uuid references auth.users,
  created_at timestamptz default now()
);
create index if not exists vnv_project on venture_note_versions(project_id, created_at desc);

-- SECURITY DEFINER is load-bearing, not decoration. The trigger inserts into
-- venture_note_versions, which has a read policy and deliberately no write
-- policy. Without SECURITY DEFINER the archive insert is refused by RLS, the
-- refusal aborts the whole statement, and every attempt to edit a venture note
-- fails. Same reason activity_from_comment() below is defined this way.
create or replace function archive_venture_note() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.body is distinct from new.body then
    insert into venture_note_versions (project_id, body, author)
    values (old.project_id, old.body, old.updated_by);
  end if;
  new.updated_at = now();
  new.updated_by = coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

drop trigger if exists venture_notes_archive on venture_notes;
create trigger venture_notes_archive before update on venture_notes
  for each row execute function archive_venture_note();

alter table venture_notes enable row level security;
drop policy if exists "member notes" on venture_notes;
create policy "member notes" on venture_notes for all
  using (is_member(project_id)) with check (is_member(project_id));

alter table venture_note_versions enable row level security;
drop policy if exists "member note history" on venture_note_versions;
create policy "member note history" on venture_note_versions for select
  using (is_member(project_id));


-- ===========================================================================
-- 6. CONTACTS — clients, partners, prospects
-- ===========================================================================

create table if not exists contacts (
  id         uuid primary key default gen_random_uuid(),
  project_id text references projects(id) on delete cascade not null,
  name       text not null,
  role       text default '',
  org        text default '',
  email      text default '',
  phone      text default '',
  note       text default '',
  created_at timestamptz default now()
);
create index if not exists contacts_project on contacts(project_id);

alter table contacts enable row level security;
drop policy if exists "member contacts" on contacts;
create policy "member contacts" on contacts for all
  using (is_member(project_id)) with check (is_member(project_id));

alter table tasks add column if not exists contact_id uuid references contacts(id) on delete set null;


-- ===========================================================================
-- 7. TARGETS — the real number each venture is chasing
-- ===========================================================================

create table if not exists targets (
  id         uuid primary key default gen_random_uuid(),
  project_id text references projects(id) on delete cascade not null,
  label      text not null,           -- 'Doors under contract'
  current    numeric not null default 0,
  goal       numeric not null,
  unit       text default '',         -- 'doors'
  due        date,
  active     boolean not null default true,
  sort       int default 0,
  created_at timestamptz default now()
);
create index if not exists targets_project on targets(project_id) where active;

alter table targets enable row level security;
drop policy if exists "member targets" on targets;
create policy "member targets" on targets for all
  using (is_member(project_id)) with check (is_member(project_id));


-- ===========================================================================
-- 8. RECURRENCES — repeating work, materialised by the agent
--    `rule` is deliberately a tiny vocabulary, not cron and not RRULE:
--       daily
--       weekly:<0-6>     0 = Sunday
--       monthly:<1-28>   day of month; 28 is the highest safe day
--    Anything richer belongs in a real scheduler, not in a text column.
-- ===========================================================================

create table if not exists recurrences (
  id         uuid primary key default gen_random_uuid(),
  project_id text references projects(id) on delete cascade not null,
  title      text not null,
  note       text default '',
  priority   text not null default 'med',
  rule       text not null,
  next_due   date not null,
  active     boolean not null default true,
  owner      uuid references auth.users,
  last_spawn date,
  created_at timestamptz default now(),
  constraint rule_shape check (
    rule = 'daily'
    or rule ~ '^weekly:[0-6]$'
    or rule ~ '^monthly:([1-9]|1[0-9]|2[0-8])$'
  )
);
create index if not exists recurrences_due on recurrences(next_due) where active;

alter table recurrences enable row level security;
drop policy if exists "member recurrences" on recurrences;
create policy "member recurrences" on recurrences for all
  using (is_member(project_id)) with check (is_member(project_id));

-- Tasks spawned from a recurrence point back at it, so the app can show the
-- repeat badge and so a spawn is never duplicated for the same date.
alter table tasks add column if not exists recurrence_id uuid references recurrences(id) on delete set null;
alter table tasks add column if not exists recurrence_for date;
create unique index if not exists tasks_recurrence_once
  on tasks(recurrence_id, recurrence_for) where recurrence_id is not null;


-- ===========================================================================
-- 9. VENTURE SETTINGS — agent controls, editable from the app
--    run.js reads these at run time. Changing a toggle takes effect on the
--    next run with no commit and no deploy. The long-form `focus` prose stays
--    in agent/profiles.js where git can track how it changed.
-- ===========================================================================

create table if not exists venture_settings (
  project_id  text primary key references projects(id) on delete cascade,
  agent_on    boolean not null default true,
  max_tasks   int not null default 3 check (max_tasks between 1 and 6),
  updated_by  uuid references auth.users,
  updated_at  timestamptz default now()
);

alter table venture_settings enable row level security;
drop policy if exists "member settings" on venture_settings;
create policy "member settings" on venture_settings for all
  using (is_member(project_id)) with check (is_member(project_id));

-- Seed the caps agreed on 2026-08-20, matching agent/profiles.js.
insert into venture_settings (project_id, agent_on, max_tasks) values
  ('pool', true, 4), ('vantyx', true, 4), ('rackpay', true, 3), ('alpha', true, 3),
  ('edge', true, 2), ('scout', true, 2), ('land', true, 2), ('tcb', true, 2)
on conflict (project_id) do nothing;


-- ===========================================================================
-- 10. DEVICES + JOBS — the Mac mini bus
--
-- The mini never accepts an inbound connection. It opens a Realtime websocket
-- to Supabase, watches `jobs` for rows addressed to it, runs them, and writes
-- results back. `devices.last_seen` is a heartbeat so the app can show whether
-- the machine is actually alive.
--
-- SECURITY — the reason job_kinds exists:
-- `jobs.kind` is a FOREIGN KEY into an allowlist table. There is no column
-- anywhere here that carries a shell command, a script path, or an arbitrary
-- payload the daemon will execute. Adding a capability is a deliberate insert
-- into job_kinds plus a handler in the daemon. If this table ever grows a
-- "command" column, a compromise of the database becomes remote code
-- execution on a machine inside the house. Do not add one.
--
-- `params` is free-form jsonb and the database cannot police what goes in it.
-- That is the daemon's job: each handler reads only the specific keys it
-- expects and ignores everything else. A handler must never pass a value out
-- of params to a shell.
-- ===========================================================================

create table if not exists devices (
  id         text primary key,          -- 'mac-mini'
  label      text not null default '',
  last_seen  timestamptz,
  version    text default '',
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table devices enable row level security;
-- Any signed-in member of the workspace can see whether the box is up.
drop policy if exists "authed devices read" on devices;
create policy "authed devices read" on devices for select
  using (auth.role() = 'authenticated');
-- Only the daemon writes here, and it uses the service key, which bypasses RLS.

insert into devices (id, label) values ('mac-mini', 'Mac mini (home)')
on conflict (id) do nothing;

create table if not exists job_kinds (
  kind        text primary key,
  description text not null default '',
  enabled     boolean not null default true
);

insert into job_kinds (kind, description) values
  ('agent.run',        'Run the daily task agent for one venture or all of them'),
  ('recurrence.spawn', 'Materialise every recurrence that is due'),
  ('alpha.collect',    'Run the Alpha Radar collectors'),
  ('scout.collect',    'Run the Scout collectors and pricing pipeline'),
  ('edge.grade',       'Grade Edge Tracker results from ESPN'),
  ('device.ping',      'No-op round trip, for proving the loop works')
on conflict (kind) do nothing;

alter table job_kinds enable row level security;
drop policy if exists "authed job kinds" on job_kinds;
create policy "authed job kinds" on job_kinds for select
  using (auth.role() = 'authenticated');

create table if not exists jobs (
  id           uuid primary key default gen_random_uuid(),
  kind         text references job_kinds(kind) not null,
  params       jsonb not null default '{}'::jsonb,
  project_id   text references projects(id) on delete cascade,
  device_id    text references devices(id) not null default 'mac-mini',
  status       text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  requested_by uuid references auth.users default auth.uid(),
  result       jsonb,
  error        text,
  attempts     int not null default 0,
  created_at   timestamptz default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index if not exists jobs_queue on jobs(device_id, status, created_at) where status = 'queued';
create index if not exists jobs_recent on jobs(created_at desc);

alter table jobs enable row level security;

-- Members can see jobs for their ventures, plus workspace-wide jobs
-- (project_id is null, e.g. a full agent run).
drop policy if exists "member reads jobs" on jobs;
create policy "member reads jobs" on jobs for select
  using (project_id is null or is_member(project_id));

-- Queueing a job is the only write the browser is allowed: insert only, always
-- as yourself, always 'queued', only for a venture you belong to. The daemon
-- moves it through running/done/failed with the service key.
drop policy if exists "member queues jobs" on jobs;
create policy "member queues jobs" on jobs for insert
  with check (
    requested_by = auth.uid()
    and status = 'queued'
    and (project_id is null or is_member(project_id))
  );


-- ===========================================================================
-- 11. ACTIVITY — what the other person did, and what you have already seen
-- ===========================================================================

create table if not exists activity (
  id         uuid primary key default gen_random_uuid(),
  project_id text references projects(id) on delete cascade,
  actor      uuid references auth.users,
  kind       text not null,            -- comment | note | done | added | job
  task_id    uuid references tasks(id) on delete cascade,
  summary    text not null default '',
  created_at timestamptz default now()
);
create index if not exists activity_recent on activity(created_at desc);

alter table activity enable row level security;
drop policy if exists "member activity" on activity;
create policy "member activity" on activity for all
  using (project_id is null or is_member(project_id))
  with check (project_id is null or is_member(project_id));

-- Read state is per person: one row per user holding the last time they
-- opened the bell. Unread = activity newer than that, by someone else.
create table if not exists activity_reads (
  user_id  uuid primary key references auth.users on delete cascade default auth.uid(),
  seen_at  timestamptz not null default now()
);

alter table activity_reads enable row level security;
drop policy if exists "own read state" on activity_reads;
create policy "own read state" on activity_reads for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Comments raise activity automatically; the app does not have to remember to.
create or replace function activity_from_comment() returns trigger as $$
declare pid text; ttl text;
begin
  select t.project_id, t.title into pid, ttl from tasks t where t.id = new.task_id;
  insert into activity (project_id, actor, kind, task_id, summary)
  values (pid, new.author, 'comment', new.task_id, left(new.body, 180));
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists comment_activity on task_comments;
create trigger comment_activity after insert on task_comments
  for each row execute function activity_from_comment();


-- ===========================================================================
-- 12. REALTIME — the tables the app and the daemon subscribe to
-- ===========================================================================

do $$
begin
  -- tasks is already published by schema.sql; the rest are new.
  begin alter publication supabase_realtime add table jobs;           exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table activity;       exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table task_comments;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table subtasks;       exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table venture_notes;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table devices;        exception when duplicate_object then null; end;
end $$;


-- ===========================================================================
-- Done. Sanity check — every row here should read the way you expect:
--
--   select project_id, role from project_members where user_id = auth.uid();
--   select project_id, agent_on, max_tasks from venture_settings order by 1;
--   select kind, enabled from job_kinds order by 1;
--   select id, label, last_seen from devices;
--
-- To give Brad Vantyx and nothing else, AFTER he has signed in once:
--
--   insert into project_members (project_id, user_id, role)
--   select 'vantyx', id, 'member' from auth.users where email = 'brad@example.com'
--   on conflict do nothing;
-- ===========================================================================
