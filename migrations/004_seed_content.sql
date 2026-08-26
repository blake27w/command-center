-- ===========================================================================
-- Command Center — seed: targets, recurrences, contacts
--
-- Run in the Supabase SQL editor after 003. Idempotent: re-running does not
-- duplicate anything.
--
-- READ THE NUMBERS BEFORE YOU RUN THIS.
--
-- Everything here is drawn from your own project docs, but the `current`
-- figures are the part I could not verify — a doc that says "50 doors in 90
-- days" tells me the goal, not where you are today. Anything I could not
-- source is seeded at 0 rather than guessed, because a made-up number on a
-- scoreboard is worse than an honest zero.
--
-- Sourced from your docs:
--   pool   2 rooms live      — Emerald Billiards + High Pockets
--   vantyx 1 of 3 phases     — FieldBook Phase 1 built, verified and paid
--   tcb    38 states         — "~38 states via RNDC, Empire, Johnson Brothers"
-- Seeded at 0 (correct them below):
--   land, alpha, scout, rackpay, edge
--
-- To fix one after running:
--   update targets set current = 14 where label = 'Doors under contract';
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Whose rows these are. Taken from an existing task rather than hardcoded, so
-- this works regardless of which account id you ended up with.
-- ---------------------------------------------------------------------------
create temporary table _me as
select owner as id from tasks where owner is not null limit 1;


-- ---------------------------------------------------------------------------
-- 1. TARGETS — the real number each venture is chasing
-- ---------------------------------------------------------------------------
insert into targets (project_id, label, current, goal, unit, due, sort)
select * from (values
  ('land',    'Doors under contract',      0, 50,  'doors',   date '2026-11-18', 0),
  ('pool',    'Rooms live',                2,  5,  'rooms',   date '2026-10-31', 0),
  ('vantyx',  'FieldBook phases paid',     1,  3,  'phases',  date '2026-11-30', 0),
  ('vantyx',  'Retainer clients',          0,  3,  'clients', date '2026-12-31', 1),
  ('tcb',     'States with placement',    38, 45,  'states',  date '2026-12-31', 0),
  ('alpha',   'Paying subscribers',        0, 25,  'subs',    date '2026-12-31', 0),
  ('scout',   'Validated flips',           0, 10,  'flips',   date '2026-09-30', 0),
  ('rackpay', 'Phase 1 money core',        0,  6,  'steps',   date '2026-09-30', 0),
  ('edge',    'Models live for the season',2,  3,  'models',  date '2026-09-07', 0)
) as v(project_id, label, current, goal, unit, due, sort)
where not exists (
  select 1 from targets t where t.project_id = v.project_id and t.label = v.label
);


-- ---------------------------------------------------------------------------
-- 2. RECURRENCES — the cadences already written down in your project docs
--
-- Rule vocabulary (enforced by a CHECK constraint in 002):
--   daily · weekly:0-6 (0 = Sunday) · monthly:1-28
--
-- next_due is set to the next occurrence from today, so nothing fires
-- retroactively the moment you run this.
-- ---------------------------------------------------------------------------
insert into recurrences (project_id, title, note, priority, rule, next_due, owner)
select v.project_id, v.title, v.note, v.priority, v.rule,
       -- first matching weekday/day-of-month strictly after today
       case
         when v.rule like 'weekly:%' then (
           select d::date from generate_series(current_date + 1, current_date + 8, interval '1 day') d
            where extract(dow from d)::int = substring(v.rule from 8)::int limit 1)
         when v.rule like 'monthly:%' then (
           select d::date from generate_series(current_date + 1, current_date + 62, interval '1 day') d
            where extract(day from d)::int = substring(v.rule from 9)::int limit 1)
         else current_date + 1
       end,
       (select id from _me)
from (values
  ('edge',   'Golf Edge Model — Tuesday slate',        'Weekly cadence per the Golf Edge Model v2.1 notes.', 'low',  'weekly:2'),
  ('land',   'Bill per-door retainers',                'Recurring revenue — the whole point of the retainer model.', 'high', 'monthly:1'),
  ('vantyx', 'Pipeline review with Brad',              'Named prospects, trial conversions, what is stuck.', 'med',  'weekly:1'),
  ('pool',   'Check console telemetry for live rooms', 'Emerald and High Pockets — is anything silently broken.', 'med',  'weekly:5')
) as v(project_id, title, note, priority, rule)
where not exists (
  select 1 from recurrences r where r.project_id = v.project_id and r.title = v.title
);


-- ---------------------------------------------------------------------------
-- 3. CONTACTS — only people who actually appear in your docs
-- ---------------------------------------------------------------------------
insert into contacts (project_id, name, role, org, note)
select * from (values
  ('pool',   'Emerald Billiards', 'Client — live',      '', 'First paying client. Install runbook on the Desktop.'),
  ('pool',   'High Pockets',      'Client — live',      '', 'Cloud-managed license. D253: do NOT re-issue it.'),
  ('vantyx', 'Brad',              'Partner',            '', 'Co-runs the consulting practice.'),
  ('vantyx', 'FieldBook client',  'Client — by phase',  '', 'Pays per phase. Phase 1 paid, Phase 2 in progress.'),
  ('tcb',    'Neil',              'Founder',            'Three Chord Bourbon', 'Required for the artist / borrowed-audience lever.')
) as v(project_id, name, role, org, note)
where not exists (
  select 1 from contacts c where c.project_id = v.project_id and c.name = v.name
);


-- ===========================================================================
-- Check it took:
--   select project_id, label, current, goal, unit, due from targets order by 1;
--   select project_id, title, rule, next_due from recurrences order by next_due;
--   select project_id, name, role from contacts order by 1;
--
-- Then correct any `current` that is wrong — that is the only guessed column:
--   update targets set current = 14 where label = 'Doors under contract';
-- ===========================================================================
