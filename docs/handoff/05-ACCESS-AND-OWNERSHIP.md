# 5. Access and ownership

This is the inventory of every account, app, key and secret in the system. It gives **names and locations only,
never values**. Today everything is owned by Media & Software Manager. The transfer checklist at the end moves it
to the client.

## Accounts and services

| # | Item | Platform / plan | Identifier | Current owner | Holds |
|---|---|---|---|---|---|
| A1 | Source repository | GitHub (public, Free) | `notm33na/hubspot-sync` | Media & Software Manager | All code, documentation, CI workflows (`ci`, `secret-scan`). **No secrets**: the workflows need none. |
| A2 | Hosting project | Vercel (Hobby) | Project `fernhill-order-sync`, address `fernhill-order-sync.vercel.app`, root directory `web` | Media & Software Manager's Vercel account | The web app, 9 environment variables (B1–B9), daily cron job, Git connection to A1 (auto-deploys `main`) |
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

Transfer in this order: **GitHub, then Supabase, then Vercel, then HubSpot**, and finish by rotating every secret.
Each platform's owner must take part, because the receiving side accepts or initiates each transfer.

### GitHub repository (A1)

1. The client creates (or chooses) the receiving GitHub account or organisation.
2. Current owner: *Repository → Settings → General → Danger Zone → Transfer ownership*, then enter the client's
   account. The client accepts by email.
3. Issues, releases and Actions history move with the repository; GitHub redirects the old address.
4. Client: run `git config core.hooksPath scripts/hooks` in their clone (see the [Setup guide](03-SETUP-GUIDE.md)).

### Supabase project (A3)

1. The client creates a Supabase organisation and invites the current owner as an **Owner** of it (both
   organisations need a shared owner for the transfer).
2. Current owner: *Project Settings → General → Transfer project*, then choose the client's organisation.
3. The project keeps its data, address and Vault secrets.
4. Remove the developer from the client's organisation once the secrets are rotated.

### Vercel project (A2)

1. The client creates a Vercel team (Vercel Pro for commercial use; see [Limitations](07-LIMITATIONS-AND-NEXT-STEPS.md))
   and invites the current owner.
2. Current owner: *Project → Settings → General → Transfer Project*, then choose the client's team. Deployments,
   environment variables and domains move with the project.
3. Client: *Settings → Git*. Reconnect the repository at its new GitHub location, root directory `web`.

**Alternative:** if a transfer is not possible, the client creates a new Vercel project from the repository (Setup guide
Steps 3 and 5). The web address then changes, so update the four address references listed in Setup guide Step 3
and re-upload the HubSpot app.

### HubSpot app (A4, A5)

The app is defined entirely in the repository (`hubspot/`). A HubSpot project belongs to the account it is uploaded to.

- **The client keeps using this HubSpot account:** add the client's people as Super admins, then remove the
  developer's user and revoke their personal access key (D1).
- **The client uses their own HubSpot account (recommended for real data):** follow Setup guide Step 4 in the
  client's account. That uploads the project, installs the app, creates the properties and adds the card. Then put
  the new `HUBSPOT_*` values into Vercel and redeploy. Contacts and deals stay in whichever account they were created in.

## Transfer checklist

- [ ] GitHub repository transferred and accepted; client admins confirmed
- [ ] Supabase project in the client's organisation; client is Owner
- [ ] Vercel project in the client's team; Git connection points at the client's repository
- [ ] HubSpot: app running in the client's chosen account; Orders card added to the contact record
- [ ] **Every secret rotated by the client** (B1, B2, B5, B7, B8, B9, B10, C2), and Vercel redeployed
- [ ] Developer access removed: GitHub collaborators, Supabase members, Vercel members, HubSpot users and keys (D1)
- [ ] Developer's copy of `.env.local` deleted (confirmed in writing)
- [ ] Smoke test passes on the client's setup (`node scripts/smoke-test.mjs --yes`)
- [ ] `/activity` shows 0 parked jobs and a `daily` line from the client-owned deployment
