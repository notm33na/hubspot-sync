# Demo video script (2–3 minutes, for clients)

Goal: show a prospective client that their HubSpot can work with their own database and website, in both
directions, reliably. Lead with what they see; mention the engineering in one or two sentences only.

## Before recording

**Reset and tidy**
- [ ] Run `node scripts/demo-reset.mjs --yes` so the data is the clean seed set.
- [ ] HubSpot: turn off automatic company creation (Settings → Objects → Companies) so contacts aren't
      attached to an "example.com" company.
- [ ] HubSpot: on the contacts list, show only the Fernhill demo contacts (filter: email contains `example.com`).

**Hide personal details**
- [ ] Use a browser profile with no bookmarks, extensions or other tabs; zoom to 110–125% so text is readable.
- [ ] Your HubSpot account name and user name appear in the top bar and the Contact owner field: rename the
      account to "Fernhill Supply Co. (demo)" for the recording, or crop/blur them in editing.
- [ ] Close notifications (Windows Focus Assist on), email and chat apps.

**Have these tabs open, in order**
1. The live form: `https://fernhill-order-sync.vercel.app`
2. HubSpot contact record: **Avery Lindqvist** (has orders), card visible
3. Supabase Table Editor: `orders` table, filtered to Avery
4. `https://fernhill-order-sync.vercel.app/activity`

**Free recording tools:** OBS Studio (best quality), or Windows Snipping Tool → Record (simplest).
Edit and add captions in Clipchamp (built into Windows). Record at 1920×1080.

## Shot list

| # | Time | On screen | Say (roughly) |
|---|---|---|---|
| 1 | 0:00–0:15 | Form page, fictional-company banner visible | "This is Fernhill Supply, a fictional company. Its orders live in its own database, and its sales team works in HubSpot. I connected the two, plus its website." |
| 2 | 0:15–0:45 | Fill the form (`@example.com` email, product, quantity) and submit; then open HubSpot and show the new contact and its deal | "A customer requests a quote on the website. Within a few seconds, HubSpot has the contact and a deal for the right amount, ready for sales." |
| 3 | 0:45–1:00 | Submit the same form again and show the "Already received" message | "If someone double-clicks or resubmits, nothing is duplicated." |
| 4 | 1:00–1:30 | Avery's contact record: scroll to the **Orders** card; point at the totals in the sidebar (total orders, lifetime value, last order) | "Sales can see every order straight from the company database, inside the contact record, without logging into another system." |
| 5 | 1:30–2:00 | Supabase: add an order for Avery (or change one's status). Back in HubSpot, refresh: the card and totals update | "When an order changes in the database, HubSpot updates in seconds." |
| 6 | 2:00–2:20 | HubSpot: change Avery's last name. Supabase: refresh the customers table to show the change | "It works the other way too: edits in HubSpot flow back to the database." |
| 7 | 2:20–2:40 | Activity page | "Every sync is logged. The integration recognises its own changes, so it never loops, and failures retry automatically and are flagged if they need attention." |
| 8 | 2:40–2:50 | Back to the form or a title card with your name and contact link | "Built on HubSpot's free developer platform, Supabase and Vercel. If your HubSpot needs to talk to your own systems, I can help." |

**Tips:** do one rehearsal first; webhooks usually land in 2–5 seconds, so a short pause before refreshing
looks natural. If something lags, cut the wait in editing rather than re-recording.

## After recording
- Run `node scripts/demo-reset.mjs --yes` to return the demo to its clean state.
- Put the video on YouTube (unlisted or public) or Loom and link it from the README and your HubSpot
  partner profile.
