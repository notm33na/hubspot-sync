# PRD — HubSpot ↔ Supabase Order Sync (portfolio demo)

Status: draft for review · 2026-10-07 · Companion: [ARCHITECTURE.md](ARCHITECTURE.md)

## 1. Purpose

A working portfolio piece that shows **a custom database and a custom front-end integrated with HubSpot CRM**:
two-way contact sync, order data shown inside HubSpot, and a public form that creates CRM records.
Audience: prospective HubSpot clients now, and the HubSpot partner directory later.

**Hard constraint: zero cost, no credit card anywhere.** Any feature that needs a paid plan is dropped or replaced.

## 2. The demo company

**Fernhill Supply Co. is fictional.** Every page, card and README says so. All data is synthetic:
names are generated, emails use `@example.com`, orders are seeded. No real customer data is ever stored:
the sync only mirrors HubSpot contacts with an `@example.com` email, and clears any stored contact whose email leaves that domain.

## 3. Users

| Who | Wants |
|---|---|
| Prospective client (HubSpot user) | See their CRM data enriched from an external database, and changes flowing both ways |
| Partner-directory reviewer | Evidence of sound integration practice: security, idempotency, rate limits |
| Demo operator (owner) | Run the demo live, reset data, see what synced and why |

## 4. Requirements

Priority: **M** = must for v1, **S** = should.

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| R1 | M | **HubSpot → Supabase contact sync.** Creating an `@example.com` contact or changing an owned field (§5) in HubSpot updates the Supabase customer. Other contacts are never stored. | A UI edit shows in Supabase within 2 min (within 10 min after a 5-min outage); duplicate or out-of-order webhooks leave one correct row. |
| R2 | M | **HubSpot deletes.** Deleting a contact in HubSpot soft-deletes the customer and clears its personal fields in Supabase; orders are kept. A restored contact is un-deleted. | After delete: `deleted_at` set and name, email and phone null. A delete whose webhook was lost is caught by the next daily run. |
| R3 | M | **Supabase → HubSpot order roll-ups.** Inserting, updating or deleting an order updates the contact's `demo_total_orders`, `demo_lifetime_value` and `demo_last_order_date`. | Roll-ups match Supabase within 2 min (within 10 min after a 5-min HubSpot outage). |
| R4 | M | **Supabase-created customers.** A customer created in Supabase without a HubSpot ID is linked to the HubSpot contact with that email, or creates one. | One contact per email; an existing contact's name is never overwritten; the customer row stores `hubspot_contact_id`. |
| R5 | M | **Orders card.** An app card on the HubSpot contact record lists that contact's orders from Supabase (newest first, 20 per page). | Renders on a **free** HubSpot account; shows an empty state for contacts with no orders. |
| R6 | M | **Demo form.** A public form on Vercel creates a contact (or reuses the existing one) and creates a deal associated with it. | The same submission (same email and content within 24 h), including after a reload or double click, never creates a second contact or deal. Only `@example.com` emails are accepted; submissions are rate-limited. |
| R7 | M | **No sync loops.** A change made by the integration never triggers a write back to its source. | A test write in each direction produces exactly one write on the other side. |
| R8 | M | **Security.** Every HubSpot request is signature-verified; secrets live only in environment variables or Supabase Vault; the database is not reachable with public keys. | Unsigned or stale requests get 401; the gitleaks scan is clean; RLS denies the anon role. |
| R9 | M | **Reliability.** Failed syncs retry automatically; permanently failing ones are parked and visible; a daily job catches anything missed. | Killing the endpoint for an hour causes no lost updates after recovery; nothing stays stuck in `pending` or `processing`. |
| R10 | M | **Stays free.** Runs indefinitely on free tiers without manual keep-alive. | Supabase project not paused after 2 weeks of the demo being idle. |
| R11 | S | **Sync activity page.** A public, read-only page lists the last 50 sync events (direction, object ID, action, outcome), including parked failures. | No personal data shown. |
| R12 | S | **Demo reset.** One command reseeds synthetic customers and orders. | Restores a known state without a flood of sync work or duplicate HubSpot contacts. |

## 5. Field ownership (the conflict rule)

Each field has exactly one owner. Only the owner's changes are synced; the other side treats the field as read-only.

| Field | Owner |
|---|---|
| First name, last name, email, phone, lifecycle stage | **HubSpot** |
| Orders, `demo_total_orders`, `demo_lifetime_value`, `demo_last_order_date` | **Supabase** |

Two creation-time exceptions, both of which **only create and never overwrite**:
a Supabase-created customer (R4) and a form submission (R6) set the name and email of a *new* HubSpot contact.
Customers are never hard-deleted in Supabase (except by the demo reset, R12); only a HubSpot delete sets `deleted_at`.

## 6. Out of scope (and why)

| Dropped | Reason |
|---|---|
| Orders as a HubSpot object | Custom objects need Enterprise; the card (R5) and roll-ups (R3) replace them |
| HubSpot-hosted serverless functions | Installing them needs Enterprise; the card calls Vercel with `hubspot.fetch` instead |
| OAuth, Marketplace listing, multi-account installs | Not needed for one demo account; static token is simpler and free |
| HubSpot workflows | Paid feature |
| Deal sync back to Supabase | Keeps v1 small; deals are only created by the form |
| Pricing, payments or "hire me" calls to action on the Vercel site | Vercel Hobby is for non-commercial use only; the portfolio pitch lives elsewhere |
| Sub-daily *Vercel* cron | Hobby allows once a day; minute-level retries use Supabase `pg_cron` instead |

## 7. Free-tier constraints that shape the design

This is the single list of limits; ARCHITECTURE refers here.

| Platform | Limit that matters |
|---|---|
| HubSpot (free CRM, static-token app) | 100 requests / 10 s per app, 250,000 / day; search has a lower limit; webhooks retry 10× over 24 h with a 5 s timeout |
| Supabase free | Pauses after 7 days inactive; 500 MB database; 2 active projects |
| Vercel Hobby | Non-commercial only; 1M function calls / month; 300 s max duration; cron once a day, ±59 min; runtime logs kept briefly |

## 8. Evidence from the spike (branch `spike`, 2026-10-07)

- App card with `hubspot.fetch` **renders on a free standard HubSpot account**; v3 signatures verified on Vercel.
- Webhooks for our own API writes arrive with `changeSource: INTEGRATION` and `sourceId: <our app id>`;
  UI edits arrive with `CRM_UI` and `userId:<id>`. This is the basis of loop prevention (R7).
- Property-change events on contact creation were inconsistent (1 run of 2), so creation handling must not rely on them.
- The demo runs on a **free standard HubSpot account**, not a developer test account, so test-account expiry does not apply.

## 9. Open questions

1. Does Supabase's per-minute `pg_cron` job count as activity for the 7-day pause rule? Verify in week 1 (R10).
2. Partner-directory listing requirements: not yet researched.
