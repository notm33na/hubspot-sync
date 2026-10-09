# 5. Access and ownership

This is the inventory of every account, app, key and secret in the system. It gives **names and locations only,
never values**. Today everything is owned by Media & Software Manager. The client takes ownership by deploying their own copy;
the checklist at the end tracks it.

## Accounts and services

| # | Item | Platform / plan | Identifier | Current owner | Holds |
|---|---|---|---|---|---|
| A1 | Source code | Git repository (developer's GitHub account) | Delivered as the `source/` folder | Media & Software Manager | All code, documentation, CI workflows (`ci`, `secret-scan`). **No secrets**: the workflows need none. |
| A2 | Hosting project | Vercel (Hobby) | Project `fernhill-order-sync`, address `fernhill-order-sync.vercel.app`, root directory `web` | Media & Software Manager's Vercel account | The web app, 9 environment variables (B1–B9), daily cron job, Git connection to the developer's repository (auto-deploys `main`) |
| A3 | Database project | Supabase (Free) | Project `fernhill-order-sync`, organisation `MSmanager`, region Northeast Asia (Seoul) | Media & Software Manager | All tables and data, Vault secrets (C1–C2), the per-minute scheduler job `drain-every-minute` |
| A4 | CRM account | HubSpot (free CRM) | Account "media and software company" | Media & Software Manager | Demo contacts and deals, the app (A5), the property group *Demo order data* |
| A5 | HubSpot app | HubSpot developer project (platform 2026.09) | Project `fernhill-order-sync`, app "Fernhill Order Sync (demo)" (private, static token), card "Orders (Fernhill demo)", webhook subscriptions | Lives inside A4 | Access token (B1), client secret (B2), app ID (B3) |
| A6 | Local configuration | Developer computer | `.env.local` in the repository folder (gitignored) | Media & Software Manager | Copies of every secret below, used by the setup and operations scripts |

## Secrets and keys

| # | Name | Where it lives | Owner | Rotate via |
|---|---|---|---|---|
| B1 | `HUBSPOT_TOKEN` | Vercel, `.env.local` | HubSpot app A5 | [Runbook: rotating secrets](04-OPERATIONS-RUNBOOK.md#rotating-secrets) |
| B2 | `HUBSPOT_CLIENT_SECRET` | Vercel, `.env.local` | HubSpot app A5 | Runbook |
| B3 | `HUBSPOT_APP_ID` (not secret) | Vercel, `.env.local` | HubSpot app A5 | Changes only if the app is re-created |
| B4 | `HUBSPOT_PORTAL_ID` (not secret) | Vercel, `.env.local` | HubSpot account A4 | Changes only with the HubSpot account |
| B5 | `SUPABASE_SECRET_KEY` | Vercel, `.env.local` | Supabase project A3 | Runbook |
| B6 | `SUPABASE_URL` (not secret) | Vercel | Supabase project A3 | Changes only with the project |
| B7 | `DRAIN_SECRET` | Vercel, `.env.local`, Supabase Vault (C2) | Generated | Runbook |
| B8 | `CRON_SECRET` | Vercel, `.env.local` | Generated | Runbook |
| B9 | `RATE_LIMIT_SALT` | Vercel, `.env.local` | Generated | Runbook |
| B10 | `SUPABASE_DB_URL` (contains the database password) | `.env.local` only | Supabase project A3 | Supabase → *Database settings* → reset password |
| C1 | Vault secret `drain_url` (not secret) | Supabase Vault | Supabase project A3 | `scripts/set-vault-secrets.sh` |
| C2 | Vault secret `drain_secret` | Supabase Vault | Supabase project A3 | `scripts/set-vault-secrets.sh` |
| D1 | HubSpot personal access key (CLI login) | The developer's HubSpot CLI configuration | The developer's HubSpot user | HubSpot → *Development → Keys* |
| D2 | Vercel and GitHub CLI logins | The developer's computer | The developer | Each platform's account settings |

All nine Vercel variables were confirmed present and encrypted on 9 October 2026 (names checked, not values). The
setup script adds the secret ones with Vercel's *Sensitive* flag.

## Transferring ownership

**Recommended: a fresh deployment on the client's own accounts.** The live system holds only synthetic demo data, so
there is nothing to migrate. The client follows the [Setup guide](03-SETUP-GUIDE.md) (about two hours) on their own
GitHub, Supabase, Vercel and HubSpot accounts. Every secret is then created fresh by the client and never known to the
developer. Once the client's deployment passes the smoke test, the developer decommissions the demo on an agreed date
(see [Decommissioning the demo](#decommissioning-the-demo)).

### Source code (A1)

The source code is delivered as a plain folder, so nothing needs to be transferred out of the developer's account.

1. The client creates a **private** repository in their own GitHub account or organisation.
2. The client pushes the `source/` folder to that repository ([Setup guide](03-SETUP-GUIDE.md), Step 1). It contains
   the code only: no git history and no credentials.
3. GitHub Actions runs the `ci` and `secret-scan` workflows on the first push. They need no configuration or secrets.
4. From then on, the client's repository is the source of truth.

### Supabase (A3) and Vercel (A2)

The client creates new projects (Setup guide Steps 2, 3, 5 and 6). To keep the web address
`fernhill-order-sync.vercel.app`, the developer deletes the demo Vercel project first, which frees the name. Otherwise
the client picks a new address and updates the four references listed in Setup guide Step 3.

Both platforms can also move an existing project between accounts (Supabase: *Project Settings → General → Transfer
project*; Vercel: *Project → Settings → General → Transfer Project*). That requires the developer and the client to be
members of each other's organisation or team during the move. It brings nothing a fresh deployment lacks, so it is
not the recommended route.

### HubSpot app (A4, A5)

The app is defined entirely in the source code (`hubspot/`). A HubSpot project belongs to the account it is uploaded to,
so the client uploads it into **their own HubSpot account** (Setup guide Step 4). That installs the app, creates the
three properties and adds the card. Contacts and deals stay in whichever account they were created in.

### Decommissioning the demo

After the client confirms their deployment works, the developer:

1. Deletes the demo Vercel project (frees the address and stops the daily job).
2. Deletes the demo Supabase project (removes all synthetic data and the Vault secrets).
3. Uninstalls the demo app in the developer's HubSpot account and archives the demo contacts and deals.
4. Deletes the local `.env.local` and confirms this in writing.

## Transfer checklist

- [ ] Source code pushed to the client's own private GitHub repository; both workflows pass
- [ ] Supabase project created in the client's account; migrations applied; Vault secrets set
- [ ] Vercel project created in the client's account, connected to the client's repository (root directory `web`)
- [ ] HubSpot app uploaded and installed in the client's account; properties created; Orders card added
- [ ] All secrets (B1–B10, C1–C2) created by the client and held only in the client's accounts
- [ ] Smoke test passes on the client's setup (`node scripts/smoke-test.mjs --yes`)
- [ ] `/activity` shows 0 parked jobs and a `daily` line from the client-owned deployment
- [ ] Demo decommissioned by the developer on the agreed date, and `.env.local` deletion confirmed in writing
