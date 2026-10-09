# 4. Operations runbook

## Daily monitoring (2 minutes)

Open **<https://fernhill-order-sync.vercel.app/activity>** (or `/activity` on your own address).

| Check | Healthy | Action if not |
|---|---|---|
| **Parked jobs needing attention** | `0` | See [Parked jobs](#parked-jobs-after-8-attempts) |
| Latest `system / daily` line | One per day, ending `0 errors` | See [What the daily job does](#what-the-daily-job-does) |
| Recent `inbound` and `outbound` lines | Outcomes such as `updated`, `unchanged`, `N orders`, `own write (echo)`, `duplicate ignored` | An `error` outcome means a job failed. It retries automatically; act only if it ends up parked. |
| Page loads | The table shows | "The activity log is unavailable" usually means the database is paused or unreachable. See [Supabase paused](#supabase-project-paused). |

**What the outcomes mean:** `updated` means the database took HubSpot's newer data. `unchanged` means nothing
differed. `stale` means an older notification arrived late and was correctly ignored. `own write (echo)` is the
integration's own change coming back, ignored by design. `N duplicates ignored` means a notification was received
again and de-duplicated. `skipped` means there was nothing to do, for example a deleted customer.

**Logs:** Vercel → project → *Logs*. The app writes one JSON line per request or job (for example `webhook_received`,
`drain`, `job_failed`, `webhook_rejected`, `daily`) and never logs names, emails or secrets.

## What the daily job does

Vercel calls `/api/cron/daily` once a day at **06:00 UTC**. On the Hobby plan Vercel may run it up to 59 minutes
late. The job:

1. Deletes activity lines and finished queue rows older than 30 days, and form rate-limit records older than 2 days.
2. Retries any queued work that is due.
3. Re-checks every contact HubSpot modified in the last **48 hours** and applies its current state. This repairs
   anything a lost notification missed.
4. Confirms every linked contact still exists in HubSpot. Deleted ones are soft-deleted in the database, and merged
   ones are re-pointed to the surviving contact.
5. Writes one `daily` line to `/activity`, such as `12 recent, 8 checked, 0 errors`.

If the line shows errors, check the Vercel logs for `daily_contact_failed` (it names the contact ID and the error).
If it shows `timed out`, the next day's run continues the work.

Separately, Supabase's scheduler signals the web app **every minute** so that queued work and retries are processed.
This also keeps the free Supabase project active.

## Common issues

### Supabase project paused

- **Symptoms:** `/activity` says the log is unavailable. Vercel logs show `webhook_insert_failed`, and the quote form fails.
- **Cause:** free Supabase projects pause after 7 days without activity. The per-minute scheduler is designed to
  prevent this, but a paused project stops the scheduler too.
- **Fix:** Supabase dashboard → project → **Restore project**, then wait a few minutes.
- **Afterwards:** HubSpot retries notifications that failed with a server error for up to 24 hours, and the daily
  job repairs changes from the last 48 hours. If the project was paused longer than 48 hours, edit or re-save the affected contacts. For a demo,
  `node scripts/demo-reset.mjs --yes` restores everything.

### HubSpot token expired, revoked or rotated

- **Symptoms:** jobs fail with `HTTP 401`, are parked immediately (a rejected request cannot succeed on retry), and
  the parked count rises. The card still loads, because it reads only from the database.
- **Fix:** get the current token from the HubSpot app's *Distribution* tab. Update `HUBSPOT_TOKEN` in `.env.local`, run
  `node scripts/push-vercel-env.mjs` from `web/`, and redeploy. Then [re-queue the parked jobs](#parked-jobs-after-8-attempts).

### Webhook signature failures

- **Symptoms:** HubSpot edits stop reaching the database. Vercel logs show `webhook_rejected` with a reason.
- **Reasons and fixes:**
  - `signature mismatch`: `HUBSPOT_CLIENT_SECRET` in Vercel is wrong or old. Update it from the app's *Auth* tab and
    redeploy. If the app was moved to a new web address, the webhook `targetUrl` and the address HubSpot calls must match.
  - `timestamp outside 5 min window`: an old request was replayed, or the sender's clock is wrong. Genuine HubSpot
    traffic is never affected.
  - `missing signature headers`: the request did not come from HubSpot. Nothing to fix.
- **Afterwards:** do not rely on HubSpot redelivering notifications that were rejected. The daily job re-checks every
  contact changed in the last 48 hours, so it repairs anything missed in that window. For a longer outage, re-save
  the affected contacts.

### Parked jobs after 8 attempts

- **Where to look:** Supabase → *Table Editor* → `sync_outbox` or `sync_inbox`, filtered to `status = dead`. The
  `last_error` column says why.
- **Typical causes:** an expired token (see above), a contact whose email is already used by another linked customer,
  or a customer outside the demo email domain.
- **Fix the cause first**, then re-queue the jobs in *SQL Editor*:
  ```sql
  update public.sync_outbox set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
   where status = 'dead';
  update public.sync_inbox  set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
   where status = 'dead';
  ```
  The per-minute signal picks them up. Check that the parked count on `/activity` returns to 0.

### Rate limits

- **HubSpot API:** the app waits as HubSpot asks when it is rate-limited (HTTP 429), then hands the job back to the
  queue with back-off. You will see `rate limited` errors that clear by themselves. HubSpot's free limits are listed
  in [Limitations](07-LIMITATIONS-AND-NEXT-STEPS.md).
- **Quote form:** each visitor can submit 5 times an hour, and the whole site 200 times a day. Raise these limits in
  `web/app/api/form/route.ts` (`PER_IP_PER_HOUR`, `SITE_PER_DAY`) if real traffic needs it.

## Demo reset

```bash
node scripts/demo-reset.mjs --yes
```

This archives every `@example.com` contact and every `Fernhill demo:` deal in HubSpot, deletes all demo data in
Supabase, then reseeds 6 synthetic contacts with 13 orders. It takes about 5 seconds and reseeded contacts get new
HubSpot IDs. **It is for the demo only.** Never run it against an account holding real customers.

## Rotating secrets

Rotate a secret straight away if it may have leaked, and otherwise on a schedule you choose (for example yearly).
After changing any value in Vercel, **redeploy**: environment changes take effect on the next deployment.

| Secret | How to rotate | Side effects |
|---|---|---|
| `HUBSPOT_TOKEN` | HubSpot app → *Distribution* tab → rotate the access token. Update `.env.local`, run `push-vercel-env.mjs`, redeploy. | Jobs fail until the redeploy, then retry. Re-queue any parked jobs. |
| `HUBSPOT_CLIENT_SECRET` | HubSpot app → *Auth* tab → rotate the client secret. Update, push, redeploy. | Webhooks are rejected until the redeploy. The next daily job repairs contacts changed meanwhile. |
| `SUPABASE_SECRET_KEY` | Supabase → *API Keys* → create a new secret key. Update, push, redeploy, then delete the old key. | None if the old key is deleted only after the redeploy. |
| Database password (in `SUPABASE_DB_URL`) | Supabase → *Database settings* → reset the password. Update `.env.local`. | Used by scripts only; the running app is unaffected. |
| `DRAIN_SECRET` | Delete its line from `.env.local` and run `push-vercel-env.mjs` (a new one is generated). Redeploy, then run `bash scripts/set-vault-secrets.sh https://<your-domain>/api/drain`. | Work signals are refused for a minute or two between the steps. Queued work waits and is not lost. |
| `CRON_SECRET` | Delete its line, run `push-vercel-env.mjs`, redeploy. | None (Vercel sends the new value automatically). |
| `RATE_LIMIT_SALT` | Delete its line, run `push-vercel-env.mjs`, redeploy. | Current form rate-limit counters reset. |
| HubSpot personal access key (CLI) | HubSpot → *Development → Keys*. Revoke, create a new one, run `hs account auth`. | CLI only. |

After a rotation, check `/activity` and run the smoke test if in doubt.
