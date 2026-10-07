# Architecture — HubSpot ↔ Supabase Order Sync

Status: draft for review · 2026-10-07 · Requirements: [PRD.md](PRD.md) · Free-tier limits: PRD §7

## 1. Overview

```
HubSpot free CRM account
 └─ App "Fernhill Order Sync (demo)" — project, static token, private
     ├─ App card on contact record ──hubspot.fetch (signed v3)──► Vercel /api/card/orders
     └─ Webhooks v3 (§3) ───────────────────────────────────────► Vercel /api/hubspot/webhook

Vercel Hobby — one Next.js app; all sync logic runs here
 ├─ /  demo form ──► /api/form ──► HubSpot API
 ├─ /activity  sync activity page (R11)
 ├─ /api/drain  ◄── Supabase pg_cron every minute + database trigger on new outbox rows
 └─ /api/cron/daily  ◄── Vercel cron, once a day: reconcile + prune

Supabase free — Postgres only: tables, triggers, pg_cron, pg_net, Vault (no Edge Functions)
```

Supabase stores data and *signals* work; Vercel *does* the work. That gives one deploy target, one log stream
and one place for application secrets.

## 2. Data model (Supabase)

| Table | Key columns | Notes |
|---|---|---|
| `customers` | `id uuid pk`, `hubspot_contact_id bigint unique`, `email unique`, `first_name`, `last_name`, `phone`, `lifecycle_stage`, `hs_last_modified`, `updated_by`, `deleted_at` | `updated_by` is `'hubspot'` (mirrors HubSpot) or `'app'` (created here, R4) |
| `orders` | `id uuid pk`, `order_number unique`, `customer_id fk ON DELETE RESTRICT`, `ordered_at`, `total_cents`, `currency`, `status` | Synthetic data only |
| `sync_inbox` | `id bigint identity pk`, `dedupe_key unique`, `payload jsonb`, `status`, `attempts`, `claimed_at`, `next_attempt_at`, `last_error` | One row per HubSpot webhook event |
| `sync_outbox` | `id`, `kind` (`rollup` \| `link_contact`), `customer_id`, `status`, `attempts`, `claimed_at`, `next_attempt_at`, `last_error` | Partial unique index on `(kind, customer_id) WHERE status = 'pending'` |
| `form_submissions` | `dedupe_key`, `email`, `status`, `claimed_at`, `contact_done`, `deal_done`, `hubspot_contact_id`, `hubspot_deal_id`, `created_at` | R6, see §7 |
| `rate_limits` | `bucket`, `window_start`, `count` | Form caps; per-IP buckets store `sha256(ip + RATE_LIMIT_SALT)`, never the raw IP |
| `sync_log` | `at`, `direction`, `object_id`, `action`, `outcome` | No personal data; feeds `/activity` |

**Job status** for both queues: `pending → processing → done | skipped | failed → … → dead`.
`dead` is terminal: a non-429 4xx error, or 8 failed attempts. Dead rows show on `/activity` and are never retried automatically.

**Access:** RLS is on for every table with no policies, and `anon` / `authenticated` grants on the `public` schema
are revoked. Only Vercel server code, using the Supabase secret (service-role) key, reads or writes data (R8).

HubSpot custom contact properties, created by an idempotent setup script (create only if missing):
`demo_total_orders`, `demo_lifetime_value`, `demo_last_order_date`, in a group named "Demo order data".

## 3. HubSpot app configuration

- **Scopes:** `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`,
  `crm.objects.deals.write`, `crm.schemas.contacts.write` (setup script only).
- **`permittedUrls.fetch`:** `https://<vercel-domain>/api/` only.
- **Webhooks:** `maxConcurrentRequests: 2`. Subscriptions:
  contact creation, deletion, privacy deletion, merge, restore, and property change for
  `firstname`, `lastname`, `email`, `phone`, `lifecyclestage`.
  **No subscription to `demo_*` properties**, so roll-up writes never produce webhooks.

## 4. Flow A — HubSpot → Supabase (R1, R2, R7, R9)

**Ingest** (`/api/hubspot/webhook`):

1. Verify the v3 signature (§8). Reject with 401.
2. Insert each event into `sync_inbox` with `ON CONFLICT (dedupe_key) DO NOTHING`.
   `dedupe_key` = `eventId`, falling back to `subscriptionId:objectId:propertyName:occurredAt`.
3. Return `204`. Only a failed insert returns 5xx, which makes HubSpot retry.
4. Drain the inbox opportunistically via `waitUntil` (§6). If that is cut short, the per-minute drain picks the rows up.

**Process one event:**

- **Echo rule:** drop an event with `changeSource = INTEGRATION` and `sourceId = HUBSPOT_APP_ID`.
  This is safe because of the **writer-records rule**: any code that writes a HubSpot-owned field with our token
  (the form, `link_contact`) writes the same result to Supabase in the same handler. The echo carries nothing new.
- **Create, property change, restore:** do not trust the event's value or order. `GET` the contact's owned
  properties plus `lastmodifieddate` (contacts have no `hs_lastmodifieddate`), then upsert. Match on `hubspot_contact_id` first, then on `email` where
  `hubspot_contact_id IS NULL` (this links instead of inserting). The write is guarded in SQL:
  `… WHERE hs_last_modified IS NULL OR hs_last_modified < $new`, so parallel batches cannot regress a row.
  A restore also clears `deleted_at`. A true email conflict with another linked row becomes `dead`, with a clear error.
- **Merge:** if `GET` returns a different `id` than the one requested, re-point the customer to the surviving ID.
  If another customer already holds that ID, move its orders to the survivor (`UPDATE orders SET customer_id = …`),
  soft-delete the duplicate, and enqueue a `rollup` for the survivor.
- **Delete, privacy delete, or `GET` returns 404:** set `deleted_at`, null `email`, `first_name`, `last_name`, `phone`.
  Orders stay.

The spike showed that property events on creation are unreliable, which is why processing always fetches current state.

## 5. Flow B — Supabase → HubSpot (R3, R4, R7, R9)

**Enqueue** (triggers, in the same transaction as the change; `INSERT … ON CONFLICT … DO NOTHING`, so a burst never fails the write):

- `orders` insert, update or delete → `rollup` for that customer.
- `customers` insert with `updated_by = 'app'` and no `hubspot_contact_id` → `link_contact`.
  Rows written by Flow A have `updated_by = 'hubspot'` and never enqueue (R7).

**Process:**

- `link_contact`: find the contact by email (§9 "Find or create"). If found, store the ID only (**no write**;
  HubSpot owns the name); otherwise create it with name and email. Then refresh the row from HubSpot through the
  Flow A fetch, and enqueue a `rollup`.
- `rollup`: if the customer is missing or has `deleted_at` set, mark it `skipped`. If it is not linked yet, set it
  back to `pending` with a 1-minute delay, or mark it `skipped` if a pending roll-up for that customer already exists. Otherwise recompute from `orders` and
  `PATCH /crm/v3/objects/contacts/{id}` with the three `demo_*` properties. Replays are harmless.

## 6. Job runner (shared by both queues)

- **Triggers:** (a) an `AFTER INSERT` trigger on `sync_outbox` calls `/api/drain` through `pg_net`;
  (b) Supabase `pg_cron` calls `/api/drain` every minute; (c) the webhook handler drains the inbox with `waitUntil`.
  The trigger and the cron job send `Authorization: Bearer <DRAIN_SECRET>`, which they read from
  **Supabase Vault** through a `SECURITY DEFINER` function, because the writing role cannot read
  `vault.decrypted_secrets`. Migrations reference the secret by name only.
- **Claiming:** `UPDATE … SET status = 'processing', claimed_at = now() WHERE id IN (SELECT id … WHERE
  (status IN ('pending','failed') AND next_attempt_at <= now()) OR (status = 'processing' AND claimed_at < now() - interval '5 min')
  ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING *`. Rows abandoned by a crashed run are reclaimed after 5 minutes.
- Rows are processed **one at a time** per invocation, within the route's `maxDuration`.
- **Failure:** `attempts + 1`, `last_error` set, `next_attempt_at` backs off 1 → 5 → 30 → 120 min.
  After 8 attempts, or on a non-429 4xx, the row becomes `dead`.

## 7. Card, form, activity page, reset

**Card (R5).** `GET /api/card/orders?contactId=…&page=…` via `hubspot.fetch`. HubSpot appends `portalId`, `userId`,
`userEmail` and `appId` and signs the whole URL, so the query string cannot be tampered with. The handler verifies
the signature, rejects any `portalId ≠ HUBSPOT_PORTAL_ID`, and returns at most 20 orders plus `nextPage`.
App code never logs the query string. Vercel's own request log does record URLs, including a HubSpot user's email,
and keeps them only briefly.

**Form (R6).**
- **Abuse control:** reject non-`@example.com` emails and filled honeypots. Limit each IP to 5 submissions per hour
  and the whole site to 200 per day (`rate_limits` table).
- **Dedupe:** `dedupe_key = sha256(lower(email) + normalized content)`. A reload or double click maps to the same
  key; a matching row created in the last 24 h is reused, and an older one is ignored. If the row is `processing`
  and `claimed_at` is under 2 min old, return 409 "in progress". A stale row is reclaimed and resumed. If the row
  is `done`, return the stored result.
- **Steps, each resumable:** (1) find or create the contact by email (§9; no overwrite),
  then write the `customers` row (writer-records rule) and set `contact_done`; (2) create the deal with its contact
  association and set `deal_done`. A retry after a partial failure resumes from the first unfinished step.

**Activity (R11).** `/activity` is public and read-only. Server code selects `at, direction, object_id, action, outcome`
from `sync_log` (limit 50) plus a count of `dead` rows. No names or emails.

**Reset (R12)** is the one exception to "never hard-delete" (PRD §5). `npm run demo:reset` disables the queue
triggers, deletes synthetic orders and customers in Supabase, empties both queues, archives contacts with
`@example.com` emails in HubSpot through the batch archive endpoint, recreates seed contacts in HubSpot first, and
then re-enables the triggers and seeds Supabase with `updated_by = 'hubspot'` and the returned IDs pre-linked.
No `link_contact` work is queued; the roll-ups queued by inserting orders go through the normal drain.

## 8. Security (R8)

**HubSpot signatures (v3).** Headers `X-HubSpot-Signature-v3` and `X-HubSpot-Request-Timestamp`. Reject a timestamp
more than 5 min old **or** more than 5 min in the future. Sign `method + URI + rawBody + timestamp` with HMAC-SHA256
using the app's client secret, base64-encode, and compare in constant time. Rules proven in the spike:
use the **raw** body (empty string for GET); rebuild the public URL from `x-forwarded-host`; decode only HubSpot's
listed characters (`%3A`, `%40`, …). A 401 response body is just `unauthorized`; the reason goes to the log only.

**Internal endpoints.** `/api/drain` checks `DRAIN_SECRET`, and `/api/cron/daily` checks Vercel's
`Authorization: Bearer $CRON_SECRET`. Both comparisons are constant-time.

**Secrets** are kept in Vercel environment variables (marked Sensitive) and a gitignored `.env.local`.
The only secret on the database side is `DRAIN_SECRET`, held in Supabase Vault.
A gitleaks pre-commit hook and a GitHub Actions job (free) scan every commit.

| Variable | Used by |
|---|---|
| `HUBSPOT_TOKEN` | All HubSpot API calls (static app token) |
| `HUBSPOT_CLIENT_SECRET` | Signature verification |
| `HUBSPOT_APP_ID`, `HUBSPOT_PORTAL_ID` | Echo rule, card portal check (not secret) |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Server-side database access |
| `DRAIN_SECRET`, `CRON_SECRET` | Internal endpoint auth |
| `RATE_LIMIT_SALT` | Hashing IPs for form rate limits |

**Personal data:** synthetic only; `@example.com` enforced on the form; PII cleared on delete; logs hold IDs and outcomes only.

## 9. HubSpot API usage (R9)

| Call | Purpose |
|---|---|
| `GET /crm/v3/objects/contacts/{id}?properties=…` | Flow A fetch |
| `GET /crm/v3/objects/contacts/{email}?idProperty=email` | Find by email (form, `link_contact`): a direct read, with no search lag |
| `POST /crm/v3/objects/contacts/search` | Daily modified-since search |
| `POST /crm/v3/objects/contacts` and `PATCH …/{id}` | Create (form, `link_contact`); roll-ups |
| `POST /crm/v3/objects/contacts/batch/read` | Daily delete check, 100 IDs per call |
| `POST /crm/v3/objects/deals` (with association) | Form |

- **Rate limits:** a per-instance bucket cannot coordinate serverless instances, so **429 with `Retry-After` is the
  main control**. Webhook concurrency is capped at 2, queue rows are processed one at a time, and the daily job
  runs search calls one after another. Waits must fit within the route's `maxDuration`; otherwise the row is released for the next drain.
- **Retries:** on 429, wait for `Retry-After`; on 5xx or network errors, back off and retry in place (3 tries), then
  hand the row back to the queue. Other 4xx errors are `dead`, with the response message stored in `last_error`.
- **Find or create:** read by email; on 404, create. If the create returns 409 (the contact already exists, because
  a parallel request won the race), read by email again and link to that contact. A 409 here is never `dead`.
- **Pagination:** follow `paging.next.after` until it is absent. Search stops at 10,000 results per query and can lag
  behind recent writes; the 48-hour window keeps us far below that cap.

## 10. Daily job (R2, R9, R10)

`/api/cron/daily` runs once a day:

1. **Missed updates:** search contacts with `lastmodifieddate` in the last 48 h and run each through the Flow A
   fetch. The echo rule does not apply here, because this path ignores `changeSource`.
2. **Missed deletes:** `batch/read` every linked `hubspot_contact_id`; any ID not returned goes through the delete
   path, and any returned with a different ID goes through the merge path.
3. Prune `sync_log` and finished queue rows older than 30 days, and form `rate_limits` older than 2 days.

Keep-alive comes from `pg_cron` querying the database every minute, and from this job (PRD open question 1).

## 11. Repository layout

```
hubspot/   HubSpot project (app, card, webhooks) — platform 2026.09
web/       Next.js app for Vercel (form, activity page, API routes)
supabase/  SQL migrations (no secret values), seed and reset scripts
docs/      PRD, architecture
```

CLI quirks on Windows (the `&` in the repo path, `--force` on the first upload, log lines) go in the README.

## 12. Traceability

| Req | Sections |
|---|---|
| R1 | §4 |
| R2 | §4, §10 |
| R3 | §5 |
| R4 | §5 `link_contact` |
| R5 | §7 Card |
| R6 | §7 Form |
| R7 | §3 subscriptions, §4 echo rule, §5 enqueue |
| R8 | §2 access, §8 |
| R9 | §4, §5, §6, §9, §10 |
| R10 | §6 pg_cron, §10 |
| R11 | §7 Activity |
| R12 | §7 Reset |

## 13. Risks to verify early

| Risk | Check |
|---|---|
| `pg_cron`, `pg_net` and Vault available on Supabase free | Enable them in the first migration; fall back to drain-on-request plus the daily job if one is missing |
| Merge, restore and privacy-deletion webhook subscriptions accepted for a static app | `hs project upload` validates the subscription list |
| What `GET` returns for a merged ID | Test once with two demo contacts |
| Custom contact property limit on free HubSpot | Setup script creates only 3; confirm none are rejected |
| `waitUntil` finishes after the 204 on Hobby | Covered anyway by the per-minute drain |
| Search API rate limit value | Confirm in HubSpot's usage guidelines before building §10 |
