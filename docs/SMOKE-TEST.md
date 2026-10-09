# Loop-safety smoke test — live deployment

Run: **2026-10-09, 04:20–04:25 UTC** against `https://fernhill-order-sync.vercel.app`, the live Supabase project and
the HubSpot demo portal. Synthetic data only (seed contact **Avery Lindqvist**, `avery.lindqvist@example.com`).
Evidence was read from Supabase (REST, service key), the HubSpot CRM API (`propertiesWithHistory`), the public
`/activity` page and Vercel runtime logs. All times are UTC. The app ID, portal ID and HubSpot user ID are redacted.

## Result

| # | Check | Result |
|---|---|---|
| 1 | Human edit simulated faithfully | **PASS**: real HubSpot UI edit (`sourceType = CRM_UI`) |
| 2 | HubSpot → DB: one processed event, DB updated, zero outbound writes | **PASS** |
| 3 | DB → HubSpot: one outbound update, no echo processing, single history change | **PASS** |
| 4 | Idempotency: replayed webhook is de-duplicated | **PASS** |
| 5 | Restore with `node scripts/demo-reset.mjs --yes` | **PASS** |

**Overall: PASS.** No loop, no duplicate processing, and no parked jobs (`/activity` showed 0 throughout).

## Baseline (2026-10-09 03:45:35)

| Where | State |
|---|---|
| `customers` (Avery) | `phone = null`, `hs_last_modified = 2026-10-07 12:33:23.46`, `updated_by = hubspot` |
| `orders` (Avery) | 4 orders (FH-1001 cancelled, so excluded from roll-ups) |
| HubSpot contact `565126099699` | `demo_total_orders = 3`, `demo_lifetime_value = 1080.29`, `demo_last_order_date = 2026-10-04`; one history entry each (2026-10-07 04:48:28, our app) |
| High-water marks | `sync_log.id = 172`, `sync_inbox.id = 130`, `sync_outbox.id = 249` |

## 1. How a human edit was simulated

The echo rule (`web/lib/sync/inbound.ts`) skips any event with `changeSource = INTEGRATION` and
`sourceId = HUBSPOT_APP_ID`. The only HubSpot credential available is the app's own token, so an API write would come
back as "own write (echo)" and never exercise Flow A. **Only a UI edit is faithful**, so the operator edited the contact
in HubSpot: **Phone number → `(201) 555-0142`** (US; the 555-01xx range is reserved for fiction). HubSpot rejected
`+1 555-0142` as an invalid format before accepting the 10-digit form.

## 2. HubSpot → DB (UI edit saved at 04:20:43.649)

| Evidence | Value |
|---|---|
| HubSpot `phone` history | 1 entry: `+12015550142`, 04:20:43.649, `sourceType = CRM_UI`, `sourceId = userId:<redacted>` |
| `sync_inbox` new rows | **1**: id 131, `contact.propertyChange` / `phone`, `changeSource = CRM_UI`, received 04:20:45.516, `done` at 04:20:47.701, attempts 1 |
| `customers` (Avery) | `phone = +12015550142`, `hs_last_modified = 04:20:43.649` (matches HubSpot), `updated_at = 04:20:47.073` |
| `sync_log` / `/activity` new rows | **1**: id 173, `04:20:48 inbound propertyChange updated 565126099699` |
| `sync_outbox` new rows | **0** (still 249 at 04:21:18) |
| HubSpot `demo_*` history | unchanged: 1 entry each, so **zero outbound writes** |

End-to-end latency (UI save to DB updated) was 3.4 s.

## 3. DB → HubSpot (order inserted at 04:21:39.440)

Inserted one synthetic order into `orders`: `FH-SMOKE-1`, Avery, 123.45 USD, `processing`.

| Evidence | Value |
|---|---|
| `sync_outbox` new rows | **1**: id 251, `rollup`, created 04:21:39.440, `done` at 04:21:41.693, attempts 1 |
| `sync_log` / `/activity` | **1**: id 174, `04:21:42 outbound rollup "4 orders"` |
| HubSpot properties | `demo_total_orders 3 → 4`, `demo_lifetime_value 1080.29 → 1203.74`, `demo_last_order_date 2026-10-04 → 2026-10-09` (all correct) |
| HubSpot property history | **exactly one new entry per property**, all at 04:21:41.043, `INTEGRATION` / our app |
| Echo webhooks | **none received**: no `sync_inbox` rows above 131 at 04:21:45 or at 04:22:22, about 40 s after the patch. This is by design: `demo_*` properties are not subscribed, so there was nothing to log as ignored. |
| Second write | **none**: no further outbox rows, and the history length stayed at 2 |
| DB side effects | `customers.updated_at` unchanged (04:20:47.073), so the roll-up did not touch the customer row |

Note: outbox id 250 does not exist. During the seed on 2026-10-07, an `ON CONFLICT DO NOTHING` enqueue consumed the
identity value. This is not related to this test.

## 4. Idempotency (replay of inbox row 131)

HubSpot's original HTTP request cannot be replayed byte for byte: its signature timestamp is outside the 5-minute window,
so it would be rejected before dedupe is reached. That itself is the first layer of protection. To reach the dedupe
layer, the stored payload of row 131 was re-sent as HubSpot sends it (a one-element JSON array) to the live
`/api/hubspot/webhook`, signed with v3 and the app's client secret.

| Sent (UTC) | Signature timestamp | HTTP | Effect |
|---|---|---|---|
| 04:22:13.886 | fresh | **204** | no new `sync_inbox` row (top id still 131), no new `sync_log` row, `customers.updated_at` unchanged |
| 04:22:14.950 | 10 min old | **401** | rejected by the timestamp check |
| 04:23:53.795 | fresh | **204** | Vercel log: `webhook_received {count: 1, inserted: 0}`, then `webhook_drain {done: 0, skipped: 0, …}` |

Dedupe key: `eventId:subscriptionId:objectId:propertyName:occurredAt`, enforced by the unique `sync_inbox.dedupe_key`.

## 5. Restore (04:24:30 → 04:24:36)

`node scripts/demo-reset.mjs --yes` archived 2 demo deals and 8 `@example.com` contacts, cleared 8 customers and
14 orders, and seeded 6 customers with 13 orders. Checked at 04:25:03:

- Avery is re-created as contact `566851215042`: `phone` is null and `FH-SMOKE-1` is gone.
- Avery's roll-ups were re-synced: 3 orders, 1080.29.
- All 5 new roll-up jobs are `done`, and the seed-creation webhooks are `skipped` as echoes.
- Parked jobs: 0.

`demo_last_order_date` now shows 2026-10-06 instead of 2026-10-04 because seed order dates are relative to the reset
time.

## Observations and fixes

All four were fixed after this run (2026-10-09); the run above predates them.

1. **A replayed webhook is invisible on `/activity`.** De-duplication shows up only as `inserted: 0` in Vercel logs,
   and the Vercel CLI streams those live only. *Proposal:* when `inserted < count`, write one `sync_log` row
   (`inbound`, `webhook`, `"N duplicate(s) ignored"`) so the idempotency guarantee is observable after the fact.
   **Fixed:** `web/app/api/hubspot/webhook/route.ts`.
2. **`/activity` mixes ID types.** Inbound rows show the HubSpot contact ID and outbound roll-ups show the Supabase
   customer UUID, so one contact's round trip cannot be followed. *Proposal:* log the HubSpot contact ID for roll-ups
   too (it is already returned by `compute_rollup`), or add both IDs.
   **Fixed:** roll-up and link jobs report the HubSpot contact ID (`web/lib/sync/outbound.ts`, `drain.ts`).
3. **Roll-ups move HubSpot's `lastmodifieddate` but not `customers.hs_last_modified`.** After step 3, HubSpot was at
   04:21:41 while the database stayed at 04:20:43. This is harmless: the next daily reconcile re-fetches the contact
   (modified in the last 48 h) and rewrites the identical row, with no HubSpot write and therefore no loop. It is
   avoidable churn. *Proposal:* skip the `UPDATE` in `apply_hubspot_contact` when every owned field is unchanged
   (advance only `hs_last_modified`).
   **Fixed:** migration `20261009000010_unchanged_contact.sql`. An identical newer state advances only
   `hs_last_modified` (still required by the out-of-order guard) and reports `unchanged`, and `updated_at` moves only
   when data changes.
4. **No repeatable smoke script.** Steps 2–4 were run with ad-hoc probes. *Proposal:* add `scripts/smoke-test.mjs`.
   It would take high-water marks, insert and later remove an order, replay the newest processed inbox row, and
   assert the counts above. The step-2 UI edit would stay a manual prompt, since only a UI or another app's token is a
   faithful non-echo source.
   **Fixed:** `node scripts/smoke-test.mjs --yes`. It waits for the UI edit (`--skip-ui` skips step 1). It cleans up
   by cancelling the smoke order rather than deleting it, so customers and orders are never hard-deleted outside the
   demo reset. Run the reset afterwards.
