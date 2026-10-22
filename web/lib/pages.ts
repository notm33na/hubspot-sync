// The two public pages as plain HTML (no framework; keeps every request inside the Workers Free CPU limit).
// Same markup, text and styles as the former Next.js pages (app/layout.tsx, app/page.tsx, app/activity/page.tsx).
import type { SyncLogRow } from './db';
import { PRODUCTS } from './form';

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `:root{--bg:#fbfaf7;--fg:#1f2328;--muted:#5d636b;--line:#d9d6cf;--accent:#2f6f4f;--accent-fg:#ffffff;--note:#fff4d6;--error:#b42318;--ok:#1f7a4d;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e8e6e1;--muted:#a3a8ae;--line:#34383d;--accent:#6fbf95;--accent-fg:#0f1a14;--note:#3a3320;--error:#ff8a80;--ok:#7dd3a5;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
.page{max-width:760px;margin:0 auto;padding:24px 16px 48px}
.note{background:var(--note);padding:8px 12px;border-radius:6px}
nav{display:flex;gap:16px;margin:8px 0 24px}
a{color:var(--accent)}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 8px}
.muted{color:var(--muted)}
form{display:grid;gap:14px;margin-top:16px}
.row{display:grid;gap:14px;grid-template-columns:1fr 1fr}
@media (max-width:560px){.row{grid-template-columns:1fr}}
label{display:grid;gap:4px;font-weight:600;font-size:.95rem}
input,select,textarea{font:inherit;color:var(--fg);background:transparent;border:1px solid var(--line);border-radius:6px;padding:8px 10px;width:100%}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.field-error{color:var(--error);font-weight:400;font-size:.875rem}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
button{font:inherit;font-weight:600;justify-self:start;background:var(--accent);color:var(--accent-fg);border:0;border-radius:6px;padding:10px 18px;cursor:pointer}
button:disabled{opacity:.6;cursor:progress}
.result{padding:10px 12px;border-radius:6px;border:1px solid var(--line)}
.result.ok{border-color:var(--ok)}
.result.err{border-color:var(--error)}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
.table-wrap{overflow-x:auto}`;

function layout(main: string, script = ''): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>Fernhill Supply Co. — HubSpot sync demo</title>`
    + `<meta name="description" content="Portfolio demo of a Supabase database and a custom front-end integrated with HubSpot CRM. Fictional company.">`
    + `<style>${CSS}</style></head><body><div class="page">`
    + `<p role="note" class="note"><strong>Fictional demo company.</strong> Fernhill Supply Co. does not exist. All data here is synthetic.</p>`
    + `<nav aria-label="Main"><a href="/">Request a quote</a><a href="/activity">Sync activity</a></nav>`
    + `${main}</div>${script}</body></html>`;
}

// Client side of the quote form (formerly the React DemoForm): same requests, messages and error display.
const FORM_SCRIPT = `<script>
(function () {
  var form = document.getElementById('quote'), button = form.querySelector('button[type=submit]');
  function clear() {
    form.querySelectorAll('.field-error').forEach(function (e) { e.remove(); });
    form.querySelectorAll('[aria-invalid]').forEach(function (e) { e.setAttribute('aria-invalid', 'false'); e.removeAttribute('aria-describedby'); });
    var old = form.querySelector('.result'); if (old) old.remove();
  }
  function result(kind, text) {
    var p = document.createElement('p'); p.setAttribute('role', 'status'); p.className = 'result ' + kind; p.textContent = text;
    form.appendChild(p);
  }
  function fieldErrors(errors) {
    Object.keys(errors).forEach(function (name) {
      var field = form.elements[name]; if (!field || !field.closest) return;
      var span = document.createElement('span'); span.className = 'field-error'; span.id = name + '-error'; span.textContent = errors[name];
      field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', span.id);
      field.closest('label').appendChild(span);
    });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clear(); button.disabled = true; button.textContent = 'Sending…';
    var body = {}; new FormData(form).forEach(function (v, k) { body[k] = v; });
    fetch('/api/form', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().then(function (data) {
          if (res.ok) result('ok', data.replayed
            ? 'Already received: this exact request was submitted earlier, so nothing new was created.'
            : 'Thanks! A contact and a deal were created in the demo HubSpot account.');
          else if (data.errors) fieldErrors(data.errors);
          else result('err', data.error || 'Something went wrong. Submitting again is safe.');
        });
      })
      .catch(function () { result('err', 'Network error. Submitting again is safe.'); })
      .then(function () { button.disabled = false; button.textContent = 'Request quote'; });
  });
})();
</script>`;

export function homePage(): string {
  const options = Object.entries(PRODUCTS)
    .map(([id, p]) => `<option value="${escapeHtml(id)}">${escapeHtml(`${p.label} ($${p.unitPrice} each)`)}</option>`)
    .join('');
  return layout(
    `<main><h1>Request a quote</h1><p class="muted">Submitting creates (or reuses) a contact and a deal in HubSpot. The contact then syncs to the Supabase order database, and its orders appear on the HubSpot contact record.</p>`
      + `<form id="quote" novalidate>`
      + `<div class="row"><label>First name<input name="firstName" autocomplete="off" required aria-invalid="false"></label>`
      + `<label>Last name<input name="lastName" autocomplete="off" required aria-invalid="false"></label></div>`
      + `<label>Email (must end in @example.com)<input name="email" type="email" placeholder="jordan@example.com" autocomplete="off" required aria-invalid="false"></label>`
      + `<div class="row"><label>Product<select name="product" required aria-invalid="false"><option value="" disabled selected>Choose…</option>${options}</select></label>`
      + `<label>Quantity<input name="quantity" type="number" min="1" max="100" value="1" required aria-invalid="false"></label></div>`
      + `<label>Message (optional)<textarea name="message" rows="3" maxlength="500"></textarea></label>`
      + `<div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>`
      + `<button type="submit">Request quote</button></form></main>`,
    FORM_SCRIPT,
  );
}

export function activityPage(data: { rows: SyncLogRow[]; dead: number } | null): string {
  if (!data) {
    return layout(`<main><h1>Sync activity</h1><p role="alert">The activity log is unavailable right now. Try again in a minute.</p></main>`);
  }
  const body = data.rows.length === 0
    ? `<tr><td colspan="5">No sync activity yet.</td></tr>`
    : data.rows.map((r) => `<tr><td>${escapeHtml(r.at.slice(0, 19).replace('T', ' '))}</td><td>${escapeHtml(r.direction)}</td>`
      + `<td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.outcome)}</td><td>${escapeHtml(r.object_id ?? '—')}</td></tr>`).join('');
  return layout(
    `<main><h1>Sync activity</h1><p class="muted">The last 50 sync events between HubSpot and the Supabase database. &ldquo;Own write (echo)&rdquo; marks webhooks caused by the integration itself, which are deliberately ignored to prevent loops.</p>`
      + `<p>Parked jobs needing attention: <strong>${escapeHtml(data.dead)}</strong></p>`
      + `<div class="table-wrap"><table><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Direction</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Object ID</th></tr></thead>`
      + `<tbody>${body}</tbody></table></div></main>`,
  );
}

export function notFoundPage(): string {
  return layout(`<main><h1>404</h1><p>This page could not be found.</p></main>`);
}
