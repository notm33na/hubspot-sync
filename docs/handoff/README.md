# Fernhill Order Sync: client handoff package

**Prepared by Media & Software Manager** · Version 1.0 · 9 October 2026

This package hands over the Fernhill Order Sync integration (HubSpot ↔ Supabase ↔ Vercel) to the team that will
own and run it. It is also available as one PDF: [Fernhill-Order-Sync-Handoff.pdf](Fernhill-Order-Sync-Handoff.pdf).

> **Fernhill Supply Co. is a fictional company.** The live deployment is a demonstration and holds only synthetic
> data: generated names, `@example.com` email addresses and seeded orders.

| # | Document | Read it if you want to… |
|---|---|---|
| 1 | [Overview](01-OVERVIEW.md) | understand what the system does and why it is useful (one page) |
| 2 | [Architecture](02-ARCHITECTURE.md) | see how the pieces fit and why the sync is safe and reliable |
| 3 | [Setup guide](03-SETUP-GUIDE.md) | deploy it from zero on your own HubSpot, Supabase, Vercel and GitHub accounts |
| 4 | [Operations runbook](04-OPERATIONS-RUNBOOK.md) | monitor it day to day, fix common problems, rotate secrets |
| 5 | [Access and ownership](05-ACCESS-AND-OWNERSHIP.md) | know every account, key and secret, and transfer ownership |
| 6 | [Testing and QA](06-TESTING-AND-QA.md) | see what is tested and the latest live test results |
| 7 | [Limitations and next steps](07-LIMITATIONS-AND-NEXT-STEPS.md) | understand free-tier limits and what changes for real customer data |
| 8 | [Handoff checklist](08-HANDOFF-CHECKLIST.md) | accept the delivery and sign it off |

## Key links

| What | Where |
|---|---|
| Live quote form | <https://fernhill-order-sync.vercel.app> |
| Live sync activity page | <https://fernhill-order-sync.vercel.app/activity> |
| Source code | <https://github.com/notm33na/hubspot-sync> |
| Release v1.0.0 (PDF, documents, demo video) | <https://github.com/notm33na/hubspot-sync/releases/tag/v1.0.0> |
| Demo video (90 seconds) | <https://github.com/notm33na/hubspot-sync/releases/download/v1.0.0/Fernhill-Order-Sync-Demo.mp4> |

**Checked on 9 October 2026:** every link above returned HTTP 200, and a gitleaks scan of the package (Markdown
and the PDF's text) found no secrets, tokens, real email addresses or personal data.

The package contains no passwords, tokens or keys. Where a secret is needed, the documents name it and say where it
is kept, never its value.

To rebuild the PDF after editing a document: `python docs/handoff/build/build_pdf.py` (needs pandoc, Chrome 131+
and the `pypdf` Python package).
