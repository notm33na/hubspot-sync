# Fernhill Order Sync — HubSpot ↔ Supabase integration demo

A working portfolio integration: **a custom database and a custom front-end connected to HubSpot CRM**,
built entirely on free tiers (no paid plan, no credit card).

> **Fernhill Supply Co. is a fictional company.** All data is synthetic: generated names,
> `@example.com` emails and seeded orders. The sync refuses to store anything else.

[![ci](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![secret-scan](../../actions/workflows/secret-scan.yml/badge.svg)](../../actions/workflows/secret-scan.yml)

## What it shows

| | |
|---|---|
| **Orders inside HubSpot** | A custom card on every contact record lists that contact's orders from the external database, newest first. |
| **Two-way sync** | Edit a contact in HubSpot and the database updates in seconds. Add an order in the database and the contact's totals (order count, lifetime value, last order date) update in HubSpot. |
| **A custom front-end** | A public quote form creates (or reuses) the HubSpot contact and creates an associated deal. Submitting twice never creates duplicates. |
| **Visible operations** | A public activity page shows every sync event, including webhooks the integration deliberately ignored to prevent loops. |

| Orders card on a HubSpot contact record | Quote form on the custom front-end |
|---|---|
| ![Orders card on a HubSpot contact record, showing orders read live from the Supabase database](docs/images/orders-card.png) | ![Quote form that creates a HubSpot contact and deal](docs/images/quote-form.png) |

Live demo: **https://fernhill.mediaandsoftwaremanager.com** (form) · **/activity** (sync log)

Built by **M&S Manger** · [case study and more builds](https://www.mediaandsoftwaremanager.com/automation#work)

### Demo video (90 seconds)

<!-- Upload the video here on github.com: edit this file and drag the .mp4 onto this line. -->


## How it works

```mermaid
flowchart LR
  subgraph HubSpot["HubSpot (free CRM)"]
    Card["Orders card<br/>on contact record"]
    Contacts[(Contacts & deals)]
  end
  subgraph Worker["Cloudflare Workers (Free)"]
    Form["Quote form"]
    API["API routes<br/>webhook · drain · card · daily cron"]
  end
  subgraph Supabase["Supabase (free)"]
    DB[(Customers & orders)]
    Queue[(Inbox / outbox queues)]
    Cron["pg_cron · pg_net"]
  end
  Contacts -- "signed webhooks" --> API
  Card -- "signed hubspot.fetch" --> API
  Form --> API
  API -- "CRM API" --> Contacts
  API <--> DB
  API <--> Queue
  Cron -- "every minute: there is work" --> API
```

- **HubSpot → database.** Webhooks are signature-checked (v3), queued, and processed after a 204 reply.
  The worker always fetches the contact's current state instead of trusting the event, so duplicate or
  out-of-order webhooks can't corrupt data.
- **Database → HubSpot.** Database triggers queue work in the same transaction as the change; a per-minute
  signal makes the Worker drain the queue. Failures retry with backoff and are parked (visible) after 8 attempts.
- **No sync loops.** Each field has one owner (HubSpot owns identity fields, the database owns orders), the
  integration recognises its own writes when they echo back as webhooks, and roll-up properties are never
  subscribed to.
- **Idempotent by design.** Webhook events, queue jobs and form submissions are all de-duplicated, and every
  step can be retried safely.
- **Self-healing.** A daily job re-checks recently changed contacts and confirms every linked contact still
  exists, catching anything a missed webhook would have lost.

Full design: [docs/PRD.md](docs/PRD.md) (requirements) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (design).
Client handoff package (setup, runbook, ownership, QA; also as one PDF): [docs/handoff/](docs/handoff/README.md).

## Stays free

| Platform | Plan | What it provides here |
|---|---|---|
| HubSpot | Free CRM + developer platform | Static-token app, app card, webhooks, CRM API |
| Supabase | Free | Postgres, `pg_cron`, `pg_net`, Vault |
| Cloudflare | Workers Free | One Worker: pages, API routes, daily Cron Trigger, custom domain |

Paid-only features were designed out: no HubSpot custom objects (the card shows orders instead), no
HubSpot-hosted serverless functions (the card calls the Worker), and Supabase `pg_cron` drives the per-minute retries.
The Worker stays inside the Free limits: no framework (pages are plain HTML, ~158 KiB compressed), and every
background drain stops before 50 subrequests and within the 30 s `waitUntil` window, leaving the rest to the next run.

## Repository layout

```
hubspot/    HubSpot project: app config, orders card (React), webhook subscriptions
web/        Cloudflare Worker: form, activity page, API routes, sync workers (worker.ts, wrangler.jsonc)
supabase/   SQL migrations and database behaviour tests
scripts/    Setup and operations: migrations, HubSpot properties, Worker secrets, Vault, demo reset
docs/       Requirements, architecture, demo script
```

## Running it yourself

You need Node 22, Docker, the HubSpot CLI (`npm i -g @hubspot/cli`), and free accounts on HubSpot,
Supabase and Cloudflare (Wrangler comes with `npm ci` in `web/`).

1. **Supabase.** Create a free project. Copy `.env.example` to `.env.local` and fill in `SUPABASE_DB_URL`
   (Connect → Session pooler) and `SUPABASE_SECRET_KEY`. Then apply the schema:
   `bash scripts/migrate.sh`
2. **HubSpot.** `hs account auth`, then from `hubspot/`: `hs project upload`. Install the app
   (project → app → Distribution → Install), and fill in `HUBSPOT_TOKEN`, `HUBSPOT_CLIENT_SECRET`,
   `HUBSPOT_APP_ID` and `HUBSPOT_PORTAL_ID`. Create the custom properties:
   `node scripts/setup-hubspot-properties.mjs`
3. **Cloudflare.** From `web/`: `npm ci`, `node node_modules/wrangler/bin/wrangler.js login`, then
   `node ../scripts/push-worker-secrets.mjs` (generates the internal secrets) and `npm run deploy`. Set your
   domain in `web/wrangler.jsonc` (`routes`, a custom domain on a zone in your Cloudflare account). If it differs
   from `fernhill.mediaandsoftwaremanager.com`, also update it in `hubspot/src/app/app-hsmeta.json`,
   `webhooks/webhooks-hsmeta.json` and `cards/OrdersCard.tsx`.
4. **Connect the queue signal.** `bash scripts/set-vault-secrets.sh https://<your-domain>/api/drain`
5. **Seed demo data.** `node scripts/demo-reset.mjs --yes`
6. In HubSpot, add the **Orders (Fernhill demo)** card to the contact record (Settings → Objects →
   Contacts → Record customization).

> **Windows:** if your path contains `&`, `.cmd` shims such as `hs`, `npx` and `npm run` scripts can fail.
> The npm scripts here call `node` directly; run CLIs the same way, for example
> `node "%APPDATA%\npm\node_modules\@hubspot\cli\bin\hs.js" project upload`.

## Tests

```bash
cd web && npm test && npm run typecheck   # 66 unit tests: signatures, HubSpot client, sync, form, daily job, routes, pages, Worker limits
bash supabase/tests/run.sh                # 77 database checks against Supabase's Postgres image (Docker)
```

CI runs both on every push. Secrets are blocked by a gitleaks pre-commit hook
(`git config core.hooksPath scripts/hooks`) and a gitleaks scan in CI.

## Operations

| Task | Command |
|---|---|
| Apply new migrations | `bash scripts/migrate.sh` (`--status` to preview) |
| Reset the demo to its seed state | `node scripts/demo-reset.mjs --yes` |
| Loop-safety smoke test on the live deployment ([results](docs/SMOKE-TEST.md)) | `node scripts/smoke-test.mjs --yes`, then reset |
| Update the HubSpot app or card | from `hubspot/`: `hs project upload` |
| Deploy the Worker | from `web/`: `npm run deploy` (`npm run build` = dry run with size) |
| Update Worker secrets | `node scripts/push-worker-secrets.mjs` (from `.env.local`) |
| Watch sync activity | `/activity` on the deployed site |

## License

[MIT](LICENSE)
