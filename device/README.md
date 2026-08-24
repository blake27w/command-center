# Command Center — Mac mini daemon

The mini is the cadence layer. GitHub Actions runs once a day at 6am; collectors
that need to run every eight hours, graders that should run all afternoon, and a
Run now button that responds in a second are all things a cron job in the cloud
can't do and a laptop can't be trusted to stay awake for.

## How it talks to the app

Nothing connects **into** this machine. No open port, no tunnel, no dynamic DNS,
no firewall exception. Both directions ride connections the mini opens itself:

```
   your phone / browser                 Supabase                  Mac mini
   ────────────────────                 ────────                  ────────
   tap "Run now"     ──insert job──>   jobs (queued)  ──realtime──>  daemon
                                                                       │
                                                                    runs it
                                                                       │
   board updates     <──realtime───    jobs (done)    <──update────  daemon
```

The mini holds a websocket open to Supabase. A queued row reaches it in about a
second. It runs the job and writes the result back, and because your app is
subscribed to the same table, the result appears without a refresh.

`devices.last_seen` is stamped every 30 seconds, so the app can show whether the
machine is actually alive rather than just assuming.

## Install

On the mini:

```bash
git clone <your repo> ~/code/command-center
cd ~/code/command-center/device

cp config.example.env .env                    # fill in the Supabase service key
cp workloads.example.json workloads.json      # fix the paths to your repos

./install.sh
```

The installer checks Node 22+, installs dependencies, writes a launchd
LaunchAgent, and starts it. launchd rather than cron because cron won't restart
a process that crashed and has no concept of keeping something alive.

It also prints the `pmset` commands to stop the mini sleeping. **Read them
before you paste them** — they need sudo. A sleeping mini doesn't error, it just
quietly stops doing the work, which is worse.

### Prove the loop works

```sql
insert into jobs (kind) values ('device.ping');
select status, result from jobs order by created_at desc limit 1;
```

Within a couple of seconds that should read `done`, with the mini's hostname in
the result. Still `queued` means the daemon isn't reaching Supabase — check
`logs/daemon.log`.

## Running it hosted instead (Railway)

The worker doesn't care where it runs — it only makes outbound connections, so
a container works exactly like the mini. Useful for getting going before the
mini exists, or as a fallback while it's down.

What a container can and can't do:

| Job kind | Hosted | Why |
|---|---|---|
| `device.ping` | yes | no dependencies |
| `recurrence.spawn` | yes | pure Supabase |
| `agent.run` | yes | `agent/run.js` is in this repo |
| `alpha.collect`, `scout.collect`, `edge.grade` | no | shell into repos that live on the mini |

The absent ones aren't broken, they're just unconfigured: a job for a kind with
no workload fails immediately with a message saying so, rather than half-running.

**Deploy**

1. Railway → New Project → Deploy from GitHub repo → `command-center`.
2. Set variables: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`,
   `OWNER_USER_ID`, `DEVICE_ID=railway`, `DEVICE_LABEL=Railway worker`,
   `WORKLOADS_FILE=device/workloads.railway.json`.
3. `railway.json` at the repo root already sets the start command and pins it to
   **one replica** — leave that alone. Two replicas would both heartbeat into the
   same `devices` row and fight over it.

Then point new jobs at it, since the schema defaults them to the mini:

```sql
insert into devices (id, label) values ('railway', 'Railway worker')
on conflict (id) do nothing;

alter table jobs alter column device_id set default 'railway';
```

**Moving to the mini later** is two lines — no redeploy, no code change:

```sql
alter table jobs alter column device_id set default 'mac-mini';
```

then stop the Railway service. Anything still queued for `railway` stays queued;
re-address it with `update jobs set device_id = 'mac-mini' where status = 'queued'`.

Both can run at once — they're separate `device_id`s and each only claims jobs
addressed to it. That's also how a second mini would work: another `DEVICE_ID`,
nothing else changes.

**Cost.** An always-on container is roughly $5/month. That's the thing the mini
eliminates, which is worth remembering when deciding how long to leave it up.

## Security

The shape of this thing is the security model. Three points, all deliberate:

**A job says what, never how.** `jobs.kind` is a foreign key into an allowlist
table, and it's checked again against the `HANDLERS` map in `daemon.mjs`. Two
independent allowlists; a kind missing from either one doesn't run.

**Commands live here, not in the database.** `workloads.json` sits on this
machine and maps a kind to an argv array. The database can ask for
`scout.collect`; only the mini decides that this means running a particular
script in a particular directory. There is no column anywhere in the schema that
carries a command, and adding one would turn a database compromise into a shell
on a machine inside your house.

**Nothing reaches a shell.** Every subprocess is `spawn(argv[0], argv.slice(1),
{ shell: false })`. No string interpolation, no `exec`. Quoting, pipes,
semicolons and globs have no meaning, so there is nothing to inject into. The
one value taken from a job row — `project_id` for `agent.run` — is validated
against the `projects` table before use, so it can only ever be an id that
already exists.

The service key in `.env` bypasses row-level security entirely. It belongs on
this machine and nowhere else: not in the repo, not in the browser bundle, not
in a screenshot.

## Job kinds

| kind | what it does |
|---|---|
| `device.ping` | No-op round trip. Proves the loop. |
| `recurrence.spawn` | Materialises every recurrence that's due. |
| `agent.run` | Runs the daily task agent — all ventures, or one with `project_id`. |
| `alpha.collect` | Alpha Radar collectors. |
| `scout.collect` | Scout collectors + pricing pipeline. |
| `edge.grade` | Edge Tracker grading from ESPN. |

### Adding one

Three places, deliberately:

1. `insert into job_kinds (kind, description) values ('thing.do', '…');`
2. a handler in the `HANDLERS` map in `daemon.mjs`
3. an entry in `workloads.json` if it shells out

If that feels like friction, it's the friction that keeps this from becoming a
remote execution endpoint.

## Scheduling

The daemon runs jobs; it doesn't decide when. Something has to queue them.
Options, roughly in order of how much you'll want them:

- **The app** — a Run now button inserts a row.
- **A local launchd timer or cron on the mini** that inserts rows on a cadence
  (`npm run ping` shows the one-liner pattern).
- **The existing GitHub Action**, which can insert a job instead of doing the
  work itself — useful while you're migrating.

Recurring *tasks* are separate from recurring *jobs*: `recurrence.spawn` reads
the `recurrences` table and creates to-dos for you. Queue it once a day.

## Operating it

```bash
tail -f logs/daemon.log                  # what it's doing
launchctl list | grep commandcenter      # is it running
launchctl unload ~/Library/LaunchAgents/com.blakewallace.commandcenter.plist
launchctl load   ~/Library/LaunchAgents/com.blakewallace.commandcenter.plist
```

Jobs run **one at a time**, in order. A long collector run delays a ping behind
it. That's intentional for now — serial execution means no two jobs can fight
over the same repo or database. If it becomes a problem, the fix is a small
worker pool keyed by workload, not raising the concurrency blindly.

If the daemon is down, jobs pile up as `queued` and run when it comes back:
`sweep()` catches anything that arrived while it was offline, which also covers
a dropped realtime message.

A recurrence that's been missed for weeks spawns **one** task, not one per
missed day, then advances to the next future date. You wanted a golf slate this
Tuesday, not twelve of them.

## What hasn't been tested

The date math, the allowlists and the syntax are verified. The Supabase
round-trip — realtime delivery, the atomic claim under contention, service-key
writes — has not been, because that needs your actual project. The `device.ping`
check above is the first thing that exercises it end to end.
