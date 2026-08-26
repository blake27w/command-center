-- ===========================================================================
-- Command Center — migration 003: trigger-driven activity + email digest state
--
-- Run in the Supabase SQL editor AFTER 002. Idempotent and non-destructive:
-- safe to re-run, never drops a table or deletes a row.
--
-- Why this exists
-- ---------------
-- 002 left activity logging to whichever client happened to make the change,
-- which meant the feed only saw what the web app did. The daily agent, the
-- worker, and anything you typed into the SQL editor were all invisible. That
-- makes "what did my partner do today" partly guesswork, which is the one
-- thing the feed exists to answer.
--
-- Here it moves into triggers on the tables themselves. Every path that
-- changes a task now produces the same activity row, and the app stops
-- writing them by hand (index-next.html is updated to match — if you run this
-- against the OLD app you will get duplicate 'done' rows until you deploy it).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. WHO DID IT
--
-- auth.uid() is null when the change came from the service key — the agent and
-- the worker both write that way. Falling back to the row's own attribution
-- keeps those rows honest instead of anonymous.
-- ---------------------------------------------------------------------------
create or replace function actor_of(explicit uuid, fallback uuid) returns uuid
language sql stable as $$ select coalesce(auth.uid(), explicit, fallback) $$;


-- ---------------------------------------------------------------------------
-- 2. TASKS -> ACTIVITY
--
-- Deliberately quiet about two things:
--   * `suggested` inserts. That is the agent proposing work; it already shows
--     up as an Inbox badge, and logging it too would bury the human activity
--     under twenty agent rows every morning.
--   * Checklist ticks. Subtasks are not logged at all — ticking five boxes on
--     one task would produce five rows and drown everything else. Task-level
--     is the right grain for "what happened".
-- ---------------------------------------------------------------------------
create or replace function activity_from_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare who uuid;
begin
  who := actor_of(new.updated_by, new.owner);

  if tg_op = 'INSERT' then
    if new.status <> 'suggested' then
      insert into activity (project_id, actor, kind, task_id, summary)
      values (new.project_id, who, 'added', new.id, left(new.title, 180));
    end if;
    return new;
  end if;

  -- status changes are the most interesting thing that happens to a task
  if old.status is distinct from new.status then
    if new.status = 'done' then
      insert into activity (project_id, actor, kind, task_id, summary)
      values (new.project_id, who, 'done', new.id, left(new.title, 180));
    elsif old.status = 'suggested' then
      insert into activity (project_id, actor, kind, task_id, summary)
      values (new.project_id, who, 'accepted', new.id, left(new.title, 180));
    elsif new.status = 'doing' then
      insert into activity (project_id, actor, kind, task_id, summary)
      values (new.project_id, who, 'started', new.id, left(new.title, 180));
    end if;
    return new;                                  -- one row per change, not two
  end if;

  if old.title    is distinct from new.title
  or old.note     is distinct from new.note
  or old.due      is distinct from new.due
  or old.priority is distinct from new.priority then
    insert into activity (project_id, actor, kind, task_id, summary)
    values (new.project_id, who, 'edited', new.id, left(new.title, 180));
  end if;

  return new;
end;
$$;

drop trigger if exists task_activity_ins on tasks;
create trigger task_activity_ins after insert on tasks
  for each row execute function activity_from_task();

drop trigger if exists task_activity_upd on tasks;
create trigger task_activity_upd after update on tasks
  for each row execute function activity_from_task();


-- ---------------------------------------------------------------------------
-- 3. VENTURE NOTES -> ACTIVITY
-- ---------------------------------------------------------------------------
create or replace function activity_from_note() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.body is not distinct from new.body then
    return new;
  end if;
  insert into activity (project_id, actor, kind, task_id, summary)
  values (new.project_id, actor_of(new.updated_by, null), 'note', null,
          left(coalesce(new.body, ''), 180));
  return new;
end;
$$;

drop trigger if exists note_activity on venture_notes;
create trigger note_activity after insert or update on venture_notes
  for each row execute function activity_from_note();


-- ---------------------------------------------------------------------------
-- 4. EMAIL DIGEST STATE
--
-- The worker reads this to decide who to email and how often. Nothing is sent
-- unless the worker has RESEND_API_KEY set — with no key, digests are simply
-- off and it says so in the log rather than failing.
--
-- min_gap_minutes is a floor, not a schedule: you get at most one email per
-- that many minutes, and none at all when nothing happened.
-- ---------------------------------------------------------------------------
create table if not exists notify_state (
  user_id         uuid primary key references auth.users on delete cascade,
  email_enabled   boolean not null default true,
  min_gap_minutes int not null default 60 check (min_gap_minutes between 5 and 1440),
  last_sent_at    timestamptz,
  created_at      timestamptz default now()
);

alter table notify_state enable row level security;
drop policy if exists "own notify state" on notify_state;
create policy "own notify state" on notify_state for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Everyone who already has an account gets the default: on, hourly at most.
insert into notify_state (user_id)
select id from auth.users
on conflict (user_id) do nothing;


-- ---------------------------------------------------------------------------
-- 5. A JOB KIND FOR TESTING THE DIGEST BY HAND
--     insert into jobs (kind) values ('digest.send');
-- ---------------------------------------------------------------------------
insert into job_kinds (kind, description)
values ('digest.send', 'Send the activity digest email to anyone who is due one')
on conflict (kind) do nothing;


-- ===========================================================================
-- Check it took:
--
--   select tgname from pg_trigger
--    where tgrelid in ('tasks'::regclass, 'venture_notes'::regclass)
--      and not tgisinternal;
--   -- expect: task_activity_ins, task_activity_upd, note_activity
--
--   select user_id, email_enabled, min_gap_minutes from notify_state;
--
-- Then make a change in the app and watch a row appear:
--   select kind, summary, created_at from activity order by created_at desc limit 5;
-- ===========================================================================
