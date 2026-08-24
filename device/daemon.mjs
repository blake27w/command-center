#!/usr/bin/env node
// ===========================================================================
// Command Center — Mac mini daemon
//
// Runs on the mini at home. Opens an outbound websocket to Supabase, watches
// the `jobs` table for work addressed to this device, runs it, writes the
// result back. Nothing ever connects INTO this machine: no open port, no
// tunnel, no dynamic DNS.
//
//   app  ──insert row──>  Supabase.jobs  ──realtime──>  daemon
//   app  <──realtime────  Supabase.jobs  <──update────  daemon
//
// SECURITY — the shape of this file is the security model, so read this before
// changing it:
//
//   * A job row carries a `kind` and a `params` object. `kind` is a foreign
//     key into an allowlist table in the database, and it is ALSO checked
//     against the HANDLERS map here. Two independent allowlists.
//
//   * Nothing from the database is ever passed to a shell. Workload commands
//     live in workloads.json ON THIS MACHINE. The database can say "run the
//     scout collector"; only the mini decides what that means.
//
//   * Every spawn uses an argv array with shell:false. There is no string
//     interpolation into a command anywhere in this file, and there must
//     never be. If you find yourself wanting `exec(...)` with a template
//     string, stop.
//
//   * A compromise of the Supabase project should cost you junk rows in a
//     table, not a shell on a machine inside your house.
// ===========================================================================

import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { hostname, uptime } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnDue } from '../agent/recurrence.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------
// config
// --------------------------------------------------------------------------
const SUPABASE_URL  = need('SUPABASE_URL');
const SERVICE_KEY   = need('SUPABASE_SERVICE_KEY');   // service key: bypasses RLS. Never ships to a browser.
const DEVICE_ID     = process.env.DEVICE_ID     || 'mac-mini';
const DEVICE_LABEL  = process.env.DEVICE_LABEL  || 'Mac mini (home)';
const HEARTBEAT_MS  = int(process.env.HEARTBEAT_SECONDS, 30) * 1000;
const SWEEP_MS      = int(process.env.SWEEP_SECONDS, 60) * 1000;
const LOG_FILE      = process.env.LOG_FILE || join(HERE, 'logs', 'daemon.log');
const LOG_MAX_BYTES = int(process.env.LOG_MAX_MB, 8) * 1024 * 1024;
const VERSION       = '1.0.0';

function need(k) {
  const v = process.env[k];
  if (!v) { console.error(`[fatal] ${k} is not set. Copy config.example.env to .env and fill it in.`); process.exit(1); }
  return v;
}
function int(v, d) { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; }

// Workload commands live here, on this machine — never in the database.
// WORKLOADS_FILE lets a hosted deployment point at a different manifest —
// a Railway container has no local repos to shell into, so it runs a smaller
// set than the mini does. Defaults to workloads.json beside this file.
const WORKLOADS = loadWorkloads();
function loadWorkloads() {
  const p = process.env.WORKLOADS_FILE
    ? resolve(process.env.WORKLOADS_FILE.replace(/^~/, process.env.HOME ?? ''))
    : join(HERE, 'workloads.json');
  if (!existsSync(p)) { log('warn', `no workload manifest at ${p} — only built-in jobs will run`); return {}; }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const out = {};
    for (const [kind, w] of Object.entries(raw)) {
      if (kind.startsWith('//')) continue;          // JSON has no comments; these keys are ours
      if (!w || typeof w !== 'object' || Array.isArray(w)) {
        throw new Error(`workload "${kind}": must be an object`);
      }
      if (!Array.isArray(w.argv) || w.argv.length === 0 || w.argv.some(a => typeof a !== 'string')) {
        throw new Error(`workload "${kind}": argv must be a non-empty array of strings`);
      }
      out[kind] = w;
    }
    return out;
  } catch (e) { log('error', `workload manifest ${p} is invalid: ${e.message}`); process.exit(1); }
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

// --------------------------------------------------------------------------
// logging — plain text, size-rotated, no dependencies
// --------------------------------------------------------------------------
function log(level, msg, extra) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) });
  console.log(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, LOG_FILE + '.1');
    appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging must never take the daemon down */ }
}

// --------------------------------------------------------------------------
// handlers — the second allowlist. A kind absent from here never runs, even
// if a row for it exists in the database.
// --------------------------------------------------------------------------
const HANDLERS = {
  'device.ping':      handlePing,
  'recurrence.spawn': handleRecurrenceSpawn,
  'agent.run':        (job) => runWorkload('agent.run', job, agentArgs(job)),
  'alpha.collect':    (job) => runWorkload('alpha.collect', job),
  'scout.collect':    (job) => runWorkload('scout.collect', job),
  'edge.grade':       (job) => runWorkload('edge.grade', job),
};

async function handlePing(job) {
  return { pong: true, host: hostname(), uptime_s: Math.round(uptime()), version: VERSION, echoed_at: new Date().toISOString() };
}

// The ONLY value taken from a job row and handed to a subprocess. It is
// validated against the projects table first, so it can only ever be one of
// the venture ids that already exist — never arbitrary text.
async function agentArgs(job) {
  const pid = job.project_id;
  if (!pid) return [];
  const { data } = await sb.from('projects').select('id').eq('id', pid).maybeSingle();
  if (!data) throw new Error(`unknown project_id: ${pid}`);
  return ['--project', data.id];
}

async function runWorkload(kind, job, extraArgsFn) {
  const w = WORKLOADS[kind];
  if (!w) throw new Error(`no workload configured for "${kind}" — add it to workloads.json on this machine`);

  const extra = typeof extraArgsFn === 'function' ? await extraArgsFn(job) : (extraArgsFn || []);
  const argv  = [...w.argv, ...extra];
  const cwd   = w.cwd ? resolve(w.cwd.replace(/^~/, process.env.HOME)) : HERE;
  const limit = int(w.timeout_seconds, 900) * 1000;

  log('info', `spawn ${kind}`, { argv, cwd });

  return await new Promise((resolveP, rejectP) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,                                   // never a shell
      env: { ...process.env, ...(w.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '', err = '', killed = false;
    const cap = (s) => s.length > 20000 ? s.slice(-20000) : s;    // keep the tail
    child.stdout.on('data', d => { out = cap(out + d); });
    child.stderr.on('data', d => { err = cap(err + d); });

    const timer = setTimeout(() => { killed = true; child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10000); }, limit);

    child.on('error', e => { clearTimeout(timer); rejectP(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (killed) return rejectP(new Error(`timed out after ${limit / 1000}s`));
      if (code !== 0) return rejectP(new Error(`exit ${code}: ${err.slice(-800) || out.slice(-800)}`));
      resolveP({ exit: 0, stdout_tail: out.slice(-4000), stderr_tail: err.slice(-1000) });
    });
  });
}

// --------------------------------------------------------------------------
// recurrence.spawn — materialise repeating tasks that are due
//
// The logic lives in agent/recurrence.js, shared with agent/run.js. Two
// implementations of date arithmetic is one too many, and this is exactly the
// kind of code that rots quietly when it is duplicated.
// --------------------------------------------------------------------------
async function handleRecurrenceSpawn() {
  return await spawnDue(sb, { log: (m) => log('info', m.trim()) });
}

// --------------------------------------------------------------------------
// job pump
// --------------------------------------------------------------------------
let busy = false;
const pending = [];

async function claim(id) {
  // Atomic claim: the status filter means only one worker can win, even if the
  // realtime event and the sweep both see the same row.
  const { data } = await sb.from('jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'queued').select().maybeSingle();
  return data;
}

async function runJob(id) {
  const job = await claim(id);
  if (!job) return;                                   // someone else got it, or it was cancelled

  const handler = HANDLERS[job.kind];
  if (!handler) {
    log('error', `no handler for kind "${job.kind}"`);
    await finish(job.id, 'failed', null, `no handler on this device for "${job.kind}"`);
    return;
  }

  log('info', `job start ${job.kind}`, { id: job.id, project: job.project_id });
  const t0 = Date.now();
  try {
    const result = await handler(job);
    await finish(job.id, 'done', { ...result, ms: Date.now() - t0 }, null);
    log('info', `job done ${job.kind}`, { id: job.id, ms: Date.now() - t0 });
  } catch (e) {
    await finish(job.id, 'failed', null, String(e.message || e).slice(0, 2000));
    log('error', `job failed ${job.kind}`, { id: job.id, error: String(e.message || e) });
  }
}

async function finish(id, status, result, error) {
  await sb.from('jobs').update({
    status, result, error, finished_at: new Date().toISOString(),
  }).eq('id', id);
}

function enqueue(id) { if (!pending.includes(id)) pending.push(id); drain(); }

async function drain() {
  if (busy) return;
  busy = true;
  try { while (pending.length) await runJob(pending.shift()); }
  finally { busy = false; }
}

// Safety net: realtime can drop a message during a reconnect. Sweeping for
// queued rows means a missed event costs a minute, not the whole job.
async function sweep() {
  const { data, error } = await sb.from('jobs')
    .select('id').eq('device_id', DEVICE_ID).eq('status', 'queued')
    .order('created_at').limit(20);
  if (error) return log('error', 'sweep failed', error.message);
  for (const j of data ?? []) enqueue(j.id);
}

// --------------------------------------------------------------------------
// heartbeat + realtime
// --------------------------------------------------------------------------
async function beat() {
  const { error } = await sb.from('devices').upsert({
    id: DEVICE_ID, label: DEVICE_LABEL, last_seen: new Date().toISOString(), version: VERSION,
    meta: { host: hostname(), uptime_s: Math.round(uptime()), node: process.version, busy },
  });
  if (error) log('error', 'heartbeat failed', error.message);
}

function subscribe() {
  sb.channel(`jobs:${DEVICE_ID}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'jobs', filter: `device_id=eq.${DEVICE_ID}` },
      (payload) => { if (payload.new?.status === 'queued') enqueue(payload.new.id); })
    .subscribe((status) => {
      log('info', `realtime ${status}`);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setTimeout(() => { try { sb.removeAllChannels(); } catch {} subscribe(); }, 5000);
      }
      if (status === 'SUBSCRIBED') sweep();           // catch anything queued while we were down
    });
}

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------
log('info', `daemon ${VERSION} starting`, { device: DEVICE_ID, workloads: Object.keys(WORKLOADS) });
await beat();
subscribe();
setInterval(beat, HEARTBEAT_MS);
setInterval(sweep, SWEEP_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log('info', `${sig} — shutting down`);
    try { await sb.from('devices').update({ meta: { stopped_at: new Date().toISOString() } }).eq('id', DEVICE_ID); } catch {}
    process.exit(0);
  });
}
process.on('unhandledRejection', (e) => log('error', 'unhandled rejection', String(e)));
