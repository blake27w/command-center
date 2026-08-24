// Command Center — recurring task materialisation.
//
// Shared by agent/run.js (GitHub Actions) and device/daemon.mjs (the worker),
// because two implementations of date arithmetic is one too many. Takes a
// Supabase client rather than creating one, so it has no dependencies and no
// opinion about which environment it runs in.
//
// The rule vocabulary is deliberately tiny and enforced by a CHECK constraint
// in migration 002:
//     daily
//     weekly:<0-6>     0 = Sunday
//     monthly:<1-28>   28 is the highest safe day — no February surprises

const ymd = (d) => d.toISOString().slice(0, 10);

// The next occurrence strictly AFTER `from`. Never returns `from` itself:
// a weekly task due Tuesday advances to next Tuesday, not to today again.
export function advance(rule, from) {
  const d = new Date(from + 'T00:00:00Z');

  if (rule === 'daily') { d.setUTCDate(d.getUTCDate() + 1); return ymd(d); }

  const wk = /^weekly:([0-6])$/.exec(rule);
  if (wk) {
    const want = Number(wk[1]);
    do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== want);
    return ymd(d);
  }

  const mo = /^monthly:(\d{1,2})$/.exec(rule);
  if (mo) return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Number(mo[1]))));

  throw new Error(`unrecognised recurrence rule: ${rule}`);
}

// Create tasks for every recurrence that has come due, then move each one to
// its next date.
//
// Two properties worth keeping:
//   * Safe to run repeatedly. The unique index on (recurrence_id,
//     recurrence_for) means a second run for the same date is rejected by the
//     database rather than quietly duplicating the task.
//   * A missed stretch produces ONE task, not one per missed day. If the
//     worker was down for three weeks you want this Tuesday's golf slate, not
//     three of them. The catch-up loop walks the date forward without
//     spawning, which is the whole point.
export async function spawnDue(sb, { today = ymd(new Date()), log = () => {} } = {}) {
  const { data: due, error } = await sb
    .from('recurrences')
    .select('*')
    .eq('active', true)
    .lte('next_due', today);

  if (error) throw new Error(`could not read recurrences: ${error.message}`);
  if (!due?.length) return { checked: 0, created: 0, skipped: 0 };

  let created = 0, skipped = 0;

  for (const r of due) {
    const { error: insErr } = await sb.from('tasks').insert({
      owner: r.owner,
      project_id: r.project_id,
      title: r.title,
      note: r.note || '',
      priority: r.priority || 'med',
      status: 'todo',
      source: 'agent',
      due: r.next_due,
      recurrence_id: r.id,
      recurrence_for: r.next_due,
    });

    // 23505 = unique violation = already spawned for this date. Expected on a
    // re-run, not a failure.
    if (insErr && insErr.code !== '23505') {
      log(`  ! ${r.title}: ${insErr.message}`);
      continue;
    }

    if (insErr) { skipped++; } else {
      created++;
      log(`  + ${r.project_id}: ${r.title} (due ${r.next_due})`);
      await sb.from('activity').insert({
        project_id: r.project_id,
        actor: r.owner,
        kind: 'added',
        summary: `Recurring: ${r.title}`,
      });
    }

    let next = r.next_due, guard = 0;
    while (next <= today && guard++ < 400) next = advance(r.rule, next);

    await sb.from('recurrences')
      .update({ next_due: next, last_spawn: r.next_due })
      .eq('id', r.id);
  }

  return { checked: due.length, created, skipped };
}
