# 7. Limitations and next steps

The system was built as a **demonstration on free tiers, with no paid plan and no credit card**. It is production-grade
in design (signed requests, queues, retries, idempotency, tests), but the free plans and the demo safeguards must
change before it handles real customers.

## Free-tier constraints

| Platform | Constraint | Effect today | Mitigation in place |
|---|---|---|---|
| **Supabase Free** | Projects **pause after 7 days of inactivity**. 500 MB database. 2 active projects per organisation. **No backups** on the live project. | A paused project stops all syncing until it is restored by hand. | The per-minute scheduler and the daily job keep the project active. The runbook explains how to restore. |
| **Vercel Hobby** | **Non-commercial use only.** 1 million function calls a month; 300 s maximum function duration; runtime logs kept only briefly. | The demo is allowed; a client business using it is not. | The site carries no pricing or sales content. |
| **Vercel Hobby cron** | Scheduled jobs run **once a day** at most, up to 59 minutes late. | The safety-net check runs daily (06:00 UTC). | Minute-level retries are driven by Supabase's scheduler instead. |
| **HubSpot API (free CRM, private app)** | 100 requests per 10 seconds and 250,000 per day per app. The search API has a lower limit. Webhooks time out after 5 s and are retried up to 10 times over 24 hours. | Ample for the demo. A large import could hit the 10-second limit. | Rate-limit responses are honoured, webhook concurrency is capped at 2, and jobs run one at a time. |
| **HubSpot free features** | Custom objects, HubSpot-hosted serverless functions and workflows need paid hubs. | Orders are shown with a card and three contact properties rather than as a HubSpot object. | — |

## Demo safeguards to remove or change for real data

These protect the demo. They must be changed deliberately when real customers are involved:

- **The `@example.com` rule.** The sync stores only contacts with `@example.com` emails (`DEMO_EMAIL_DOMAIN` in
  `web/lib/hubspot.ts`). The form accepts only those emails, and the daily job clears anything else. For real use,
  replace it with the client's own rule: which contacts to sync (for example a list or lifecycle stage).
- **The demo reset** archives every `@example.com` contact and wipes the database. Remove `scripts/demo-reset.mjs` (or
  guard it) in a real deployment.
- **Property names** (`demo_total_orders` and the others) and the "(demo)" app and card names should be renamed.
- **The public activity page** shows IDs and outcomes only, but a business may prefer it behind a login.
- **Fernhill branding** and the "fictional company" banner on the website.

## What changes for real customer data

| Topic | Recommendation |
|---|---|
| **Paid tiers** | Supabase Pro (no pausing, daily backups, more capacity) and Vercel Pro (commercial use, cron more often than daily, longer log retention). HubSpot: the client's existing subscription; Operations Hub or Enterprise only if custom objects or workflows are wanted. |
| **Privacy and DPA** | Sign each vendor's Data Processing Addendum (HubSpot, Supabase, Vercel). Record the integration in your records of processing. Update the privacy notice for the website form. Set a retention policy for orders and for the `sync_log`; the current 30-day log pruning is a starting point. |
| **Data region** | The demo database is in **Northeast Asia (Seoul)**, and Vercel functions run in Vercel's default region. For EU or UK customer data, create the Supabase project in an EU region and set the Vercel function region to match. Region cannot be changed after a Supabase project is created, so plan a migration. |
| **Backups and recovery** | Turn on Supabase backups (Pro: daily; Point-in-Time Recovery as an add-on), and test a restore once. HubSpot remains the system of record for contacts; the database is the system of record for orders. |
| **Access and security** | Use organisation-owned accounts (not personal ones) with 2-factor sign-in. Rotate all secrets at handover. Add a GitHub branch protection rule so that `main` requires passing CI. |
| **Monitoring** | Add an alert when the parked-job count is above zero or the daily job reports errors (for example a small uptime or log-alert service), rather than relying on someone checking `/activity`. |

## Upgrade roadmap (prioritised)

| Priority | Item | Why |
|---|---|---|
| **1. Before any real data** | Move to client-owned accounts and rotate all secrets ([Access and ownership](05-ACCESS-AND-OWNERSHIP.md)) | Ownership and security |
| **1** | Supabase Pro in the right region, with backups on | No pausing, recoverability, data residency |
| **1** | Vercel Pro | Licence terms for commercial use |
| **1** | Replace the `@example.com` rule and remove the demo reset | The demo safeguards would block or delete real data |
| **1** | DPAs signed and privacy notice updated | Legal basis for processing |
| **2. First month** | Alerting on parked jobs and daily-job errors | Problems found in minutes, not days |
| **2** | Activity page behind a login, or internal only | Least exposure |
| **2** | Rename the demo properties, app and card | Clean user experience in HubSpot |
| **3. Later** | Sync deals or other objects back to the database; richer order details on the card | Business features, depending on need |
| **3** | Run the reconciliation more often (Vercel Pro cron) | Faster self-healing after outages |
