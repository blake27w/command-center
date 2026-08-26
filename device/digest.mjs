// Command Center — activity digest email.
//
// Runs inside the worker. Every few minutes it asks: has anyone accumulated
// activity from the OTHER person that they have not been emailed about yet?
// If so, one short email; if not, silence.
//
// Three rules that keep it from becoming noise:
//   * You are never emailed about your own actions.
//   * `min_gap_minutes` in notify_state is a floor — at most one email per
//     that window, per person. Default 60.
//   * Nothing happened means nothing is sent. There is no "no news" email.
//
// With no RESEND_API_KEY set, digests are simply off: it logs that once and
// stops. Nothing errors, nothing retries.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function digestConfigured() { return !!process.env.RESEND_API_KEY; }

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const VERB = {
  added:    'added',
  done:     'finished',
  started:  'started',
  accepted: 'accepted',
  edited:   'edited',
  comment:  'left a note on',
  note:     'updated the venture note',
  job:      'ran',
};

function renderEmail(rows, projects, appUrl) {
  const byProject = new Map();
  for (const r of rows) {
    const key = r.project_id || '—';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(r);
  }

  const name = (id) => projects[id]?.name || id || 'Workspace';
  const lines = [];
  const html = [];

  for (const [pid, items] of byProject) {
    lines.push(`${name(pid)}`);
    html.push(`<h3 style="margin:22px 0 8px;font:600 15px/1.3 -apple-system,Segoe UI,sans-serif;color:#211D17">${esc(name(pid))}</h3><ul style="margin:0;padding-left:18px">`);
    for (const it of items) {
      const verb = VERB[it.kind] || it.kind;
      const body = it.kind === 'note' ? '' : ` "${it.summary || ''}"`;
      lines.push(`  · ${verb}${body}`);
      html.push(`<li style="margin:4px 0;font:400 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#5A5245">${esc(verb)}${
        body ? ` <span style="color:#211D17">${esc((it.summary || '').slice(0,160))}</span>` : ''}</li>`);
    }
    html.push('</ul>');
    lines.push('');
  }

  const n = rows.length;
  const subject = `${n} update${n === 1 ? '' : 's'} in your Command Center`;

  const text = `${n} thing${n === 1 ? '' : 's'} happened while you were away.\n\n${lines.join('\n')}${
    appUrl ? `\nOpen the Command Center: ${appUrl}\n` : ''}`;

  const htmlBody = `<div style="max-width:520px;margin:0 auto;padding:24px;background:#F2EDE1">
    <div style="font:600 19px/1.2 Georgia,serif;color:#211D17;margin-bottom:4px">Command Center</div>
    <div style="font:400 14px/1.4 -apple-system,Segoe UI,sans-serif;color:#8C846F">${n} update${n === 1 ? '' : 's'} while you were away</div>
    ${html.join('')}
    ${appUrl ? `<p style="margin-top:26px"><a href="${esc(appUrl)}" style="display:inline-block;background:#80332E;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font:600 14px -apple-system,Segoe UI,sans-serif">Open Command Center</a></p>` : ''}
  </div>`;

  return { subject, text, html: htmlBody };
}

async function sendViaResend({ to, subject, text, html }) {
  const from = process.env.DIGEST_FROM || 'Command Center <onboarding@resend.dev>';
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text, html }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

// Returns a summary of what it did, so the caller can log it or hand it back
// as a job result.
export async function runDigest(sb, { log = () => {}, force = false } = {}) {
  if (!digestConfigured()) { log('digest: no RESEND_API_KEY — skipping'); return { skipped: 'not configured' }; }

  const appUrl = process.env.APP_URL || '';

  const { data: states, error: se } = await sb.from('notify_state').select('*').eq('email_enabled', true);
  if (se) throw new Error(`notify_state: ${se.message}`);
  if (!states?.length) return { checked: 0, sent: 0 };

  const { data: projRows } = await sb.from('projects').select('id,name');
  const projects = Object.fromEntries((projRows || []).map(p => [p.id, p]));

  const now = Date.now();
  let sent = 0, skipped = 0;

  for (const s of states) {
    const gapMs = (s.min_gap_minutes ?? 60) * 60000;
    const since = s.last_sent_at ? new Date(s.last_sent_at) : new Date(now - 24 * 3600 * 1000);

    if (!force && s.last_sent_at && (now - new Date(s.last_sent_at).getTime()) < gapMs) { skipped++; continue; }

    // only ventures this person actually belongs to
    const { data: mem } = await sb.from('project_members').select('project_id').eq('user_id', s.user_id);
    const ids = (mem || []).map(m => m.project_id);
    if (!ids.length) { skipped++; continue; }

    const { data: rows, error: ae } = await sb.from('activity')
      .select('project_id,actor,kind,summary,created_at')
      .in('project_id', ids)
      .neq('actor', s.user_id)                       // never your own doing
      .gt('created_at', since.toISOString())
      .order('created_at')
      .limit(40);
    if (ae) { log(`digest: activity read failed — ${ae.message}`); continue; }
    if (!rows?.length) { skipped++; continue; }

    // the service key can read auth.users; a browser never could
    const { data: u, error: ue } = await sb.auth.admin.getUserById(s.user_id);
    const to = u?.user?.email;
    if (ue || !to) { log(`digest: no email for ${s.user_id}`); continue; }

    const mail = renderEmail(rows, projects, appUrl);
    try {
      await sendViaResend({ to, ...mail });
      await sb.from('notify_state').update({ last_sent_at: new Date().toISOString() }).eq('user_id', s.user_id);
      sent++;
      log(`digest: sent ${rows.length} update(s) to ${to}`);
    } catch (e) {
      log(`digest: send failed for ${to} — ${e.message}`);
    }
  }

  return { checked: states.length, sent, skipped };
}

export const _internal = { renderEmail };
