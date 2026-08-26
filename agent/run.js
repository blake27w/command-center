// Command Center — daily task agent.
//
// For each venture it asks Claude for a few good next tasks, drops
// near-duplicates, and inserts the survivors as `suggested` for review in the
// Inbox. Also materialises any recurring tasks that have come due.
//
// Runs from two places:
//   * GitHub Actions, once a day  (.github/workflows/agent.yml)
//   * the worker, on demand       (device/daemon.mjs, job kind `agent.run`)
//
// Usage:
//   node run.js                      every enabled venture, plus recurrences
//   node run.js --project pool       just that venture, no recurrences
//   node run.js --recurrences-only   materialise recurrences and stop
//   node run.js --dry-run            propose and print, write nothing
//
// Uses the SERVICE key (bypasses RLS), so every inserted row sets `owner`
// explicitly to OWNER_USER_ID.
//
// Env:
//   ANTHROPIC_API_KEY    — Claude API key
//   SUPABASE_URL         — project URL
//   SUPABASE_SERVICE_KEY — service_role key (NEVER ship to the client)
//   OWNER_USER_ID        — the auth.users id of the workspace owner
//   AGENT_MODEL          — optional; default claude-sonnet-4-6

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { profiles } from './profiles.js';
import { spawnDue } from './recurrence.js';

const {
  ANTHROPIC_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  OWNER_USER_ID,
  AGENT_MODEL,
} = process.env;

const MODEL = AGENT_MODEL || 'claude-sonnet-4-6';

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? null; };

const ONLY_PROJECT     = value('--project');
const RECURRENCES_ONLY = flag('--recurrences-only');
const DRY_RUN          = flag('--dry-run');
// A scoped run is someone pressing "Run now" on one venture; they don't expect
// it to also spawn every recurring task across the workspace.
const DO_RECURRENCES   = !ONLY_PROJECT && !flag('--no-recurrences');

// ---- guard rails -----------------------------------------------------------
for (const [k, v] of Object.entries({
  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, OWNER_USER_ID,
})) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const supabase  = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---- helpers ---------------------------------------------------------------

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Cheap token-overlap similarity: true if `candidate` is close enough to
// something that already exists that proposing it again would be noise.
function isDuplicate(candidate, existingTitles) {
  const c = normalize(candidate);
  if (!c) return true;
  const cWords = new Set(c.split(' ').filter(Boolean));
  for (const t of existingTitles) {
    const e = normalize(t);
    if (!e) continue;
    if (e === c) return true;
    if (e.includes(c) || c.includes(e)) return true;
    const eWords = new Set(e.split(' ').filter(Boolean));
    const inter = [...cWords].filter((w) => eWords.has(w)).length;
    const denom = Math.max(cWords.size, eWords.size) || 1;
    if (inter / denom >= 0.6) return true;
  }
  return false;
}

// Per-venture agent settings, editable from the app without a deploy.
// profiles.js keeps the long-form `focus` prose, because that belongs in git
// where you can see how it changed; on/off and the daily cap live in the
// database so a toggle takes effect on the next run.
async function loadSettings() {
  const { data, error } = await supabase
    .from('venture_settings')
    .select('project_id, agent_on, max_tasks');

  if (error) {
    console.error(`  ! venture_settings unreadable (${error.message}) — falling back to profiles.js`);
    return {};
  }
  return Object.fromEntries((data || []).map((r) => [r.project_id, r]));
}

// Existing open/suggested titles for one venture.
//
// Deliberately NOT filtered by owner. Visibility is per-venture now, so a
// partner's tasks are part of the same board — filtering by owner would hide
// them from the agent and it would cheerfully re-propose work someone else is
// already doing.
async function existingTitlesFor(projectId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('title')
    .eq('project_id', projectId)
    .in('status', ['todo', 'doing', 'suggested']);

  if (error) { console.error(`  ! failed to read existing tasks: ${error.message}`); return []; }
  return (data || []).map((r) => r.title);
}

function parseProposals(raw) {
  if (!raw) return [];
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) text = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`  ! could not parse model output: ${e.message}`);
    return [];
  }
}

const VALID_PRIORITY = new Set(['high', 'med', 'low']);

async function proposeFor(profile, cap, existingTitles, ventureCount) {
  const sys = `You are the daily planning agent for "${profile.name}", one of ${ventureCount}
ventures run by a solo operator. Propose only genuinely useful NEXT tasks.

Return ONLY a JSON array (no preamble, no markdown fences) of at most ${cap}
objects, each: {"title": string, "priority": "high"|"med"|"low", "note"?: string}.
Return [] if nothing is worth adding today — an empty day is a fine answer and is
preferred over filler. Titles must be concrete and actionable (start with a verb).
Do NOT repropose anything already in the existing-tasks list below (including
near-duplicates / rewordings). Some of those tasks may belong to a partner
rather than the operator; treat them as taken either way.`;

  const user = `VENTURE FOCUS:
${profile.focus}

EXISTING OPEN/SUGGESTED TASKS (do not duplicate these):
${existingTitles.length ? existingTitles.map((t) => `- ${t}`).join('\n') : '(none yet)'}

Propose up to ${cap} task(s) now as a JSON array.`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });

  return parseProposals(
    (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  );
}

// ---- main ------------------------------------------------------------------
async function main() {
  if (RECURRENCES_ONLY) {
    console.log('Command Center agent — recurrences only');
    const r = await spawnDue(supabase, { log: (m) => console.log(m) });
    console.log(`Done. ${r.created} created, ${r.skipped} already existed, ${r.checked} due.`);
    return;
  }

  const settings = await loadSettings();

  let queue = profiles;
  if (ONLY_PROJECT) {
    queue = profiles.filter((p) => p.id === ONLY_PROJECT);
    if (!queue.length) { console.error(`No profile for project "${ONLY_PROJECT}"`); process.exit(1); }
  }

  // A venture with no settings row is treated as on — a missing row should
  // mean "not configured yet", never a silently disabled venture.
  const enabled = queue.filter((p) => settings[p.id]?.agent_on !== false);
  const paused  = queue.length - enabled.length;

  console.log(
    `Command Center agent — model=${MODEL} — ${enabled.length} venture(s)` +
    (paused ? `, ${paused} paused` : '') + (DRY_RUN ? ' — DRY RUN' : '')
  );

  let totalInserted = 0;
  let errored = 0;
  const failures = [];

  for (const profile of enabled) {
    const cap = settings[profile.id]?.max_tasks ?? profile.maxTasks ?? 3;
    try {
      const existing  = await existingTitlesFor(profile.id);
      const proposals = await proposeFor(profile, cap, existing, profiles.length);

      const rows = [];
      for (const p of proposals) {
        const title = (p && p.title ? String(p.title) : '').trim();
        if (!title) continue;
        if (isDuplicate(title, existing)) continue;
        rows.push({
          owner: OWNER_USER_ID,
          project_id: profile.id,
          title,
          note: p.note ? String(p.note) : '',
          priority: VALID_PRIORITY.has(p.priority) ? p.priority : 'med',
          status: 'suggested',
          source: 'agent',
        });
        existing.push(title);              // block intra-batch duplicates too
        if (rows.length >= cap) break;
      }

      if (!rows.length) { console.log(`  ${profile.name}: nothing proposed`); continue; }

      if (DRY_RUN) {
        console.log(`  ${profile.name}: would add ${rows.length} — ${rows.map((r) => r.title).join(' | ')}`);
        continue;
      }

      const { error } = await supabase.from('tasks').insert(rows);
      if (error) { console.error(`  ${profile.name}: insert failed — ${error.message}`); continue; }

      totalInserted += rows.length;
      console.log(`  ${profile.name}: +${rows.length} suggested → ${rows.map((r) => r.title).join(' | ')}`);
    } catch (e) {
      errored++;
      failures.push(`${profile.name}: ${e.message}`);
      console.error(`  ${profile.name}: error — ${e.message}`);
    }
  }

  if (DO_RECURRENCES && !DRY_RUN) {
    console.log('Recurring tasks:');
    try {
      const r = await spawnDue(supabase, { log: (m) => console.log(m) });
      if (!r.checked) console.log('  none due');
    } catch (e) {
      console.error(`  ! ${e.message}`);
    }
  }

  console.log(`Done. Inserted ${totalInserted} suggested task(s).`);

  // ---- fail loudly when nothing worked ------------------------------------
  //
  // This exists because of a real incident: the Anthropic credit balance ran
  // out in early July, every venture failed every morning for seven weeks, and
  // the run still exited 0 — so GitHub Actions stayed green, the job row said
  // `done`, and nothing anywhere said a word. It was found by accident.
  //
  // A PARTIAL failure is tolerable and only warns: one venture erroring should
  // not throw away the other seven's suggestions. TOTAL failure is different —
  // it means the agent is dead, and it should look dead.
  if (enabled.length > 0 && errored === enabled.length) {
    console.error('');
    console.error(`FAILED: all ${errored} venture(s) errored. Nothing was written.`);
    for (const f of failures.slice(0, 3)) console.error(`  - ${f}`);

    const all = failures.join(' ');
    if (/credit balance/i.test(all)) {
      console.error('');
      console.error('  This is an Anthropic billing problem, not a code problem.');
      console.error('  Top up at console.anthropic.com -> Plans & Billing, then run again.');
    } else if (/api[_ ]?key|authentication|401/i.test(all)) {
      console.error('');
      console.error('  Looks like ANTHROPIC_API_KEY is missing or invalid.');
    }
    process.exit(1);
  }

  if (errored > 0) {
    console.error(`Warning: ${errored} of ${enabled.length} venture(s) errored but others succeeded.`);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
