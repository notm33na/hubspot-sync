# 3. Setup guide: deploying from zero

This guide deploys the whole system on **your own** GitHub, Supabase, Vercel and HubSpot accounts. Allow about two
hours the first time. Each step ends with a **Verify** check, so do not move on until it passes.

The commands are run from a terminal in the repository folder. Commands starting `bash` need a Bash shell (Git Bash
on Windows).

## Before you start

**Accounts (all have free plans):**

| Account | Plan | Notes |
|---|---|---|
| GitHub | Free | Holds the code and runs tests on every push |
| Supabase | Free | Database. Choose a region close to your customers (see [Limitations](07-LIMITATIONS-AND-NEXT-STEPS.md)) |
| Vercel | Hobby (free) | Hosting. **Hobby is for non-commercial use only**; a business deployment needs Vercel Pro |
| HubSpot | Free CRM or higher | You need permission to create apps (Super admin, or the *App Marketplace / Developer* permissions) |

**Software on the computer doing the setup:**

| Tool | Install |
|---|---|
| Node.js 22 | <https://nodejs.org> |
| Git | <https://git-scm.com> |
| Docker Desktop (must be running) | <https://www.docker.com/products/docker-desktop/>. Used to run database migrations and tests. |
| HubSpot CLI | `npm i -g @hubspot/cli` |
| Vercel CLI | `npm i -g vercel` |
| gitleaks (recommended) | `winget install Gitleaks.Gitleaks` or `brew install gitleaks`. Blocks commits that contain secrets. |

> **Windows tip.** If the folder path contains `&`, the `hs`, `npx` and `vercel` shortcuts can fail. Run the CLIs
> through Node instead, for example `node "%APPDATA%\npm\node_modules\@hubspot\cli\bin\hs.js" project upload`.

## Step 1: Get the code

1. Copy the repository to your own GitHub account: accept a repository transfer (see
   [Access and ownership](05-ACCESS-AND-OWNERSHIP.md)) or fork <https://github.com/notm33na/hubspot-sync>.
2. Clone it, then turn on the secret-scan hook:
   ```bash
   git clone https://github.com/<your-account>/hubspot-sync.git
   cd hubspot-sync
   git config core.hooksPath scripts/hooks
   ```
3. Copy `.env.example` to `.env.local`. This file holds your secrets locally and is never committed.

**Verify:** `git status` shows a clean tree and `.env.local` is not listed (it is ignored).

## Step 2: Supabase (database)

1. In Supabase, create a new project. Save the database password in your password manager.
2. **`SUPABASE_DB_URL`:** *Connect → Session pooler*. Copy the connection string and put your database password in it.
3. **`SUPABASE_SECRET_KEY`:** *Project Settings → API Keys → Secret keys*. Create or copy a key starting `sb_secret_`.
4. Put both in `.env.local`, then create the database schema:
   ```bash
   bash scripts/migrate.sh
   ```

**Verify:** `bash scripts/migrate.sh --status` lists every migration as `applied`. In *Table Editor* you see
`customers`, `orders`, `sync_inbox`, `sync_outbox`, `sync_log`, `form_submissions` and `rate_limits`.

## Step 3: Vercel project and web address

1. From the `web/` folder run `vercel link` and create a new project. Your address is
   `https://<project-name>.vercel.app` (or a custom domain you add later).
2. If your address is not `fernhill-order-sync.vercel.app`, replace it in these four places and commit:
   - `hubspot/src/app/app-hsmeta.json` (`permittedUrls.fetch`, documentation and support URLs)
   - `hubspot/src/app/webhooks/webhooks-hsmeta.json` (`targetUrl`)
   - `hubspot/src/app/cards/OrdersCard.tsx` (`API_BASE`)
3. In Vercel, *Project → Settings → Git*: connect the GitHub repository, with **Root Directory** set to `web`. From
   then on, every push to `main` deploys to production automatically.

**Verify:** the project appears in your Vercel dashboard and is connected to your repository.

## Step 4: HubSpot app

1. Sign the CLI in to your HubSpot account: `hs account auth` (it asks for a personal access key, created in HubSpot
   under *Development → Keys*).
2. Upload the app from the `hubspot/` folder: `hs project upload`. The first upload to a new account may need `--force`.
3. Install it: *Development → Projects → fernhill-order-sync → app → Distribution → Install*.
4. Copy four values into `.env.local`:
   - **`HUBSPOT_TOKEN`** is the access token on the app's *Distribution* tab.
   - **`HUBSPOT_CLIENT_SECRET`** is the client secret on the *Auth* tab.
   - **`HUBSPOT_APP_ID`** is the app ID on the *Auth* tab.
   - **`HUBSPOT_PORTAL_ID`** is your HubSpot account ID, shown in the account menu (top right).
5. Create the three order-total contact properties:
   ```bash
   node scripts/setup-hubspot-properties.mjs
   ```

**Verify:** the script prints `created` (or `exists`) for the group and all three properties. In HubSpot,
*Settings → Properties → Contact properties* shows the group **Demo order data**.

## Step 5: Configure and deploy the web app

1. From `web/`, copy the configuration into Vercel:
   ```bash
   node ../scripts/push-vercel-env.mjs
   ```
   This generates `DRAIN_SECRET`, `CRON_SECRET` and `RATE_LIMIT_SALT` into `.env.local` if they are missing. It then
   adds every variable to Vercel's *Production* environment, marking secrets as *Sensitive*. It prints names and
   `ok` only, never values. (The script finds the Vercel CLI in the Windows global npm folder. On macOS or Linux, add
   the variables in *Vercel → Settings → Environment Variables* instead, using the table below.)
2. Deploy: push to `main`, or run `vercel deploy --prod` from `web/`.

**Verify:** your web address shows the quote form, and `/activity` shows "No sync activity yet."

## Step 6: Connect the database to the web app

Store the work-signal address and secret in Supabase Vault:

```bash
bash scripts/set-vault-secrets.sh https://<your-domain>/api/drain
```

**Verify:** the script prints `vault secrets set: 2`.

## Step 7: Load demo data and add the card

1. Seed the demo data (synthetic contacts in HubSpot and matching customers and orders in Supabase):
   ```bash
   node scripts/demo-reset.mjs --yes
   ```
2. In HubSpot: *Settings → Objects → Contacts → Record customization*. Add the **Orders (Fernhill demo)** card to the
   contact record.

**Verify:** `/activity` lists `rollup` lines. Opening the contact *Avery Lindqvist* shows the Orders card and the
three order totals.

## Step 8: End-to-end check

Run the loop-safety smoke test (about two minutes, including one edit you make in HubSpot when asked):

```bash
node scripts/smoke-test.mjs --yes
node scripts/demo-reset.mjs --yes
```

**Verify:** the script ends with `PASS: all 16 checks`. If it does not, see the [Operations runbook](04-OPERATIONS-RUNBOOK.md).

## Every environment variable

None of these values may be committed. `.env.local` is gitignored and the secret scan blocks accidental commits.

| Name | Purpose | Where to get it | Stored in | Secret? |
|---|---|---|---|---|
| `HUBSPOT_TOKEN` | Authorises every HubSpot API call the app makes | HubSpot app → *Distribution* tab → access token | `.env.local`, Vercel | **Yes** |
| `HUBSPOT_CLIENT_SECRET` | Verifies that webhooks and card requests really come from HubSpot | HubSpot app → *Auth* tab → client secret | `.env.local`, Vercel | **Yes** |
| `HUBSPOT_APP_ID` | Recognises the app's own writes, so they are not synced back (loop prevention) | HubSpot app → *Auth* tab → app ID | `.env.local`, Vercel | No |
| `HUBSPOT_PORTAL_ID` | Card requests from any other HubSpot account are refused | HubSpot account menu → account ID | `.env.local`, Vercel | No |
| `SUPABASE_SECRET_KEY` | Server-side database access (bypasses row-level security; never sent to a browser) | Supabase → *Project Settings → API Keys → Secret keys* | `.env.local`, Vercel | **Yes** |
| `SUPABASE_DB_URL` | Direct database connection for migrations and Vault setup (scripts only) | Supabase → *Connect → Session pooler* | `.env.local` only | **Yes** (contains the database password) |
| `SUPABASE_URL` | Address of the Supabase API | Derived automatically from `SUPABASE_DB_URL`; set it only to override | Vercel | No |
| `DRAIN_SECRET` | Lets Supabase tell the web app that work is waiting | Generated by `push-vercel-env.mjs` | `.env.local`, Vercel, Supabase Vault (`drain_secret`) | **Yes** |
| `CRON_SECRET` | Authorises Vercel's daily job call | Generated by `push-vercel-env.mjs`; Vercel sends it automatically | `.env.local`, Vercel | **Yes** |
| `RATE_LIMIT_SALT` | Hashes visitor IP addresses for form rate limits, so raw IPs are never stored | Generated by `push-vercel-env.mjs` | `.env.local`, Vercel | **Yes** |

Supabase Vault also holds `drain_url`, the address of `/api/drain`, set in Step 6.

**Changing a variable in Vercel only takes effect after the next deployment.**
