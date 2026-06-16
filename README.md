# Command Center

A synced, multi-venture task manager for one operator. The installed web app is
just a window onto a **Supabase** database — your iPhone (home-screen web app) and
your Mac read and write the same rows and update **live**. A daily **GitHub
Actions** job proposes tasks per venture into an **Inbox** you approve or dismiss.

One owner. One database. One repo. No partner hardware, no always-on server.

The seven ventures: **Alpha Radar**, **Vantyx**, **Landscape & Junk Removal**,
**Three Chord Bourbon**, **Edge Tracker**, **Pool Hall Pro**, **Scout**.

```
/index.html                  # the app (GitHub Pages serves this)
/agent/run.js                # daily task agent (Node, ESM)
/agent/profiles.js           # the seven venture profiles
/agent/package.json
/.github/workflows/agent.yml # daily cron (+ manual run button)
/schema.sql                  # Supabase schema — run once in the SQL editor
/README.md
```

---

## One-time setup

### 1. Create the Supabase project & schema
1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query →** paste all of [`schema.sql`](schema.sql) → **Run**.
   This creates `projects` + `tasks`, the RLS policies, the `updated_at` trigger,
   seeds the seven ventures, and turns on Realtime for `tasks`.
3. Confirm Realtime: **Database → Replication → `supabase_realtime`** — `tasks`
   should be on (the schema's last line does this; the toggle is the fallback).
4. **Authentication → Providers →** make sure **Email** is enabled (magic link is
   on by default). Under **URL Configuration**, add your GitHub Pages URL (below)
   to **Site URL** / **Redirect URLs** so the magic link returns to the app.

### 2. Put your keys in the app
Open [`index.html`](index.html), find the **CONFIG** block near the bottom, and
replace the two placeholders:

```js
const SUPABASE_URL      = "__SUPABASE_URL__";       // Settings → API → Project URL
const SUPABASE_ANON_KEY = "__SUPABASE_ANON_KEY__";  // Settings → API → anon / publishable key
```

Both are **safe to ship in the client** — Row Level Security gates every task row
to the signed-in owner. The **service_role key never goes here.**

### 3. Deploy on GitHub Pages
1. Push this repo to `blake27w/command-center` (already done if Claude created it).
2. **Settings → Pages →** Source: **Deploy from a branch**, Branch: **`main`** /
   **`/ (root)`** → Save. Wait for the green check; note the URL
   (`https://blake27w.github.io/command-center/`).
3. Open the URL, sign in (below), then **Add to Home Screen** on the iPhone. A
   web manifest + app icon make it install as a real standalone app (custom icon,
   no Safari chrome), and a service worker (`sw.js`) makes it open instantly and
   load its shell even on a flaky/offline connection.
4. **Updates still ship with no reinstall.** The service worker is *network-first*
   for the app itself: when online you always get the freshest deploy, so a
   `git push` lands on the next open. The cache is only an offline fallback — it
   never pins you to a stale build. (Bump `VERSION` in `sw.js` if you ever want to
   force-invalidate all caches.)

### 4. Wire the daily agent secrets
You need the owner's Supabase user id first: sign in to the app once (step below),
then in Supabase go to **Authentication → Users** and copy your user's **UID**.

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**,
add all four:

| Secret | Value | Where it lives |
|---|---|---|
| `ANTHROPIC_API_KEY` | your Claude API key | GitHub secret only |
| `SUPABASE_URL` | same Project URL as the app | GitHub secret only |
| `SUPABASE_SERVICE_KEY` | **service_role** key (Settings → API) | **GitHub secret only — never in the client, never committed** |
| `OWNER_USER_ID` | your auth user UID | GitHub secret only |

> Optional: add a repo secret/variable `AGENT_MODEL = claude-haiku-4-5-20251001`
> to run the agent cheaper. Default is `claude-sonnet-4-6`.

---

## How to use it

### Sign in
Open the Pages URL → enter your email → **Send magic link** → click the link in
your inbox. The session **persists per device**, so you sign in once on the phone
and once on the Mac. Do this on both.

### The four views
- **Focus** — open tasks that are high priority, in progress, or due within 2 days.
- **By project** — grouped and color-coded by venture.
- **All open** — every open task, flat, sorted by priority then due date.
- **Inbox** — the agent's `suggested` tasks. **Accept** moves one into your real
  list; **Dismiss** deletes it. The badge counts pending suggestions. Suggested
  tasks appear **only** here until accepted.

Tap a task's **✎** to edit title / venture / priority / status / due / notes, or
the checkbox to mark it done. The **quick-add bar** is pinned to the bottom: pick
a venture, type, **Add**.

### Add from Claude (paste-import)
Bottom bar → **Add from Claude** → paste a JSON array:

```json
[{"project_id":"tcb","title":"Call the RNDC rep about Q3 placement","priority":"high","note":""}]
```

Each item needs `project_id` and `title` (`priority`/`note` optional). They import
as active to-dos (`source = claude`). Valid `project_id`s:
`alpha, vantyx, land, tcb, edge, pool, scout`.

### Export backup
Bottom bar → **Export backup** downloads a JSON snapshot. Supabase is the source
of truth; this is just peace of mind.

---

## The daily agent

`.github/workflows/agent.yml` runs `agent/run.js` once a day at **11:00 UTC
(~6:00 AM Central)**. For each venture it reads your existing open/suggested
titles, asks Claude for up to a few good next tasks (thin ventures **Pool Hall
Pro** and **Scout** get at most one "define scope" nudge), drops near-duplicates,
and inserts the survivors as `suggested` — which surface in your **Inbox**.

**Run it on demand:** GitHub → **Actions → daily-task-agent → Run workflow**.
Watch suggestions land in the Inbox within ~2s of the job finishing.

---

## Verifying it works
- [ ] Schema applied; seven projects seeded; Realtime on `tasks`.
- [ ] App signs in via magic link; session persists on each device.
- [ ] A change on the phone appears on the Mac within ~2s, no refresh.
- [ ] Focus / By project / All open / Inbox all work; suggested tasks only show
      in Inbox until accepted.
- [ ] **Add from Claude** inserts rows.
- [ ] A manual agent run (`workflow_dispatch`) populates the Inbox.
- [ ] `git grep` for the service key finds nothing — it lives only in GitHub
      secrets: `git grep -i service_role` returns no client/committed hits.

---

## Where each secret lives (at a glance)
| Value | Client (`index.html`) | GitHub Actions secret |
|---|:---:|:---:|
| `SUPABASE_URL` | ✅ | ✅ |
| `SUPABASE_ANON_KEY` (publishable) | ✅ | — |
| `SUPABASE_SERVICE_KEY` (service_role) | ❌ never | ✅ |
| `ANTHROPIC_API_KEY` | ❌ never | ✅ |
| `OWNER_USER_ID` | — | ✅ |

---

## Phase 2 (not built — out of scope here)
Direct in-chat task writes via an always-on endpoint; Alpha Radar **signal-aware**
mode fed by the Mac mini (~July 10); push notifications. The agent profiles keep
`signalAware: false` until then.
