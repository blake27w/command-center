// Command Center — daily task agent.
//
// Runs once a day from GitHub Actions (.github/workflows/agent.yml). For each
// venture it asks Claude for up to a few good next tasks, drops near-duplicates,
// and inserts the survivors into Supabase as `suggested` tasks for the owner to
// review in the Inbox.
//
// Uses the SERVICE key (server-side only — bypasses RLS), so every inserted row
// must explicitly set `owner` to OWNER_USER_ID.
//
// Env (all GitHub repo secrets):
//   ANTHROPIC_API_KEY    — Claude API key
//   SUPABASE_URL         — project URL
//   SUPABASE_SERVICE_KEY — service_role key (NEVER ship to the client)
//   OWNER_USER_ID        — the auth.users id of the single owner
//   AGENT_MODEL          — optional override; default claude-sonnet-4-6
//                          (set to claude-haiku-4-5-20251001 to run cheaper)

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { profiles } from './profiles.js';

const {
  ANTHROPIC_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  OWNER_USER_ID,
  AGENT_MODEL,
} = process.env;

const MODEL = AGENT_MODEL || 'claude-sonnet-4-6';

// ---- guard rails -----------------------------------------------------------
for (const [k, v] of Object.entries({
  ANTHROPIC_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  OWNER_USER_ID,
})) {
  if (!v) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---- helpers ---------------------------------------------------------------

// Normalize a title for fuzzy duplicate detection.
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cheap token-overlap similarity. Returns true if `candidate` is "close enough"
// to any existing title that we should drop it as a duplicate.
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
    if (inter / denom >= 0.6) return true; // >=60% word overlap → treat as dup
  }
  return false;
}

// Pull the existing open/suggested task titles for one venture.
async function existingTitlesFor(projectId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('title')
    .eq('project_id', projectId)
    .eq('owner', OWNER_USER_ID)
    .in('status', ['todo', 'doing', 'suggested']);
  if (error) {
    console.error(`  ! failed to read existing tasks: ${error.message}`);
    return [];
  }
  return (data || []).map((r) => r.title);
}

// Strip stray markdown fences and parse a JSON array, defensively.
function parseProposals(raw) {
  if (!raw) return [];
  let text = raw.trim();
  // remove ```json ... ``` or ``` ... ``` fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // if there's prose around it, grab the first [...] block
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`  ! could not parse model output: ${e.message}`);
    return [];
  }
}

const VALID_PRIORITY = new Set(['high', 'med', 'low']);

// Ask Claude for proposals for one venture.
async function proposeFor(profile, existingTitles) {
  const sys = `You are the daily planning agent for "${profile.name}", one of seven
ventures run by a solo operator. Propose only genuinely useful NEXT tasks.

Return ONLY a JSON array (no preamble, no markdown fences) of at most ${profile.maxTasks}
objects, each: {"title": string, "priority": "high"|"med"|"low", "note"?: string}.
Return [] if nothing is worth adding today — an empty day is a fine answer and is
preferred over filler. Titles must be concrete and actionable (start with a verb).
Do NOT repropose anything already in the existing-tasks list below (including
near-duplicates / rewordings).`;

  const user = `VENTURE FOCUS:
${profile.focus}

EXISTING OPEN/SUGGESTED TASKS (do not duplicate these):
${existingTitles.length ? existingTitles.map((t) => `- ${t}`).join('\n') : '(none yet)'}

Propose up to ${profile.maxTasks} task(s) now as a JSON array.`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });

  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return parseProposals(text);
}

// ---- main ------------------------------------------------------------------
async function main() {
  console.log(`Command Center agent — model=${MODEL} — ${profiles.length} ventures`);
  let totalInserted = 0;

  for (const profile of profiles) {
    try {
      const existing = await existingTitlesFor(profile.id);
      const proposals = await proposeFor(profile, existing);

      const rows = [];
      for (const p of proposals) {
        const title = (p && p.title ? String(p.title) : '').trim();
        if (!title) continue;
        if (isDuplicate(title, existing)) continue;
        const priority = VALID_PRIORITY.has(p.priority) ? p.priority : 'med';
        rows.push({
          owner: OWNER_USER_ID,
          project_id: profile.id,
          title,
          note: p.note ? String(p.note) : '',
          priority,
          status: 'suggested',
          source: 'agent',
        });
        // also block intra-batch dups
        existing.push(title);
        if (rows.length >= profile.maxTasks) break;
      }

      if (rows.length === 0) {
        console.log(`  ${profile.name}: nothing proposed`);
        continue;
      }

      const { error } = await supabase.from('tasks').insert(rows);
      if (error) {
        console.error(`  ${profile.name}: insert failed — ${error.message}`);
        continue;
      }
      totalInserted += rows.length;
      console.log(`  ${profile.name}: +${rows.length} suggested → ${rows.map((r) => r.title).join(' | ')}`);
    } catch (e) {
      console.error(`  ${profile.name}: error — ${e.message}`);
    }
  }

  console.log(`Done. Inserted ${totalInserted} suggested task(s).`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
