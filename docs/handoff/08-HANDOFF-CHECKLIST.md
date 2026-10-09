# 8. Handoff checklist and sign-off

Tick each item once you have seen it working. Items marked **(live)** can be checked on the public deployment today;
the others need the client's own accounts.

## Functionality

- [ ] **(live)** The quote form at <https://fernhill-order-sync.vercel.app> creates a contact and a deal in HubSpot, and a second identical submission shows "Already received" without creating duplicates.
- [ ] **(live)** The **Orders** card on a HubSpot contact lists that contact's orders, newest first, and shows an empty state for a contact with no orders.
- [ ] **(live)** Editing a contact's name, email, phone or lifecycle stage in HubSpot updates the database within 2 minutes.
- [ ] **(live)** Adding an order in the database updates the contact's total orders, lifetime value and last order date in HubSpot within 2 minutes.
- [ ] **(live)** Deleting a demo contact in HubSpot clears its personal details in the database and keeps its orders.
- [ ] **(live)** <https://fernhill-order-sync.vercel.app/activity> lists sync events with no names or emails, and shows "Parked jobs needing attention: 0".

## Reliability and safety

- [ ] **(live)** No sync loops: one change produces exactly one write on the other side (smoke test steps 1 and 2).
- [ ] **(live)** Duplicate notifications are ignored and shown as "duplicate ignored" (smoke test step 3).
- [ ] **(live)** A `daily` line appears on `/activity` each day.
- [ ] Unsigned or stale requests to the webhook, card, drain and daily endpoints are refused (covered by unit tests).

## Quality evidence

- [ ] Both GitHub Actions workflows (`ci`, `secret-scan`) pass on the delivered commit.
- [ ] 54 unit tests and 77 database checks pass.
- [ ] The latest smoke test passes all 16 checks ([Testing and QA](06-TESTING-AND-QA.md)).
- [ ] The handoff package contains no secrets, tokens, real emails or personal data.

## Ownership and documentation

- [ ] Documents 1–7 and this checklist received, as Markdown and as the PDF.
- [ ] Deployed on the client's own GitHub, Supabase, Vercel and HubSpot accounts ([Access and ownership](05-ACCESS-AND-OWNERSHIP.md)).
- [ ] All secrets created by the client; the demo deployment decommissioned on the agreed date.
- [ ] The client has run `node scripts/smoke-test.mjs --yes` on their own setup.
- [ ] Limitations and the upgrade roadmap read and accepted ([Limitations and next steps](07-LIMITATIONS-AND-NEXT-STEPS.md)).

## Sign-off

By signing, the client accepts delivery of Fernhill Order Sync version 1.0 as described in this package.

| | Client | Media & Software Manager |
|---|---|---|
| Name | | |
| Role | | |
| Date | | |
| Signature | | |

Notes or exceptions:

&nbsp;

&nbsp;

&nbsp;
