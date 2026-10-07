-- A failed form submission may have created its deal just before failing. The resume step finds that
-- deal by searching HubSpot, and HubSpot search lags writes (~8 s measured on 2026-10-07). Hold off
-- resuming a failed row for 15 s after its last attempt so the deal is searchable first.
create or replace function public.claim_form_submission(p_key text, p_email text)
returns table (submission_id bigint, outcome text, contact_done boolean, deal_done boolean,
               hubspot_contact_id bigint, hubspot_deal_id bigint)
language plpgsql as $$
declare
  v_row public.form_submissions;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_key, 0));

  select * into v_row from public.form_submissions f
   where f.dedupe_key = p_key and f.created_at > now() - interval '24 hours'
   order by f.created_at desc limit 1;

  if not found then
    insert into public.form_submissions (dedupe_key, email) values (p_key, p_email)
    returning * into v_row;
    return query select v_row.id, 'new'::text, false, false, null::bigint, null::bigint;
  elsif v_row.status = 'done' then
    return query select v_row.id, 'done'::text, v_row.contact_done, v_row.deal_done,
                        v_row.hubspot_contact_id, v_row.hubspot_deal_id;
  elsif (v_row.status = 'processing' and v_row.claimed_at > now() - interval '2 minutes')
     or (v_row.status = 'failed' and v_row.claimed_at > now() - interval '15 seconds') then
    return query select v_row.id, 'in_progress'::text, v_row.contact_done, v_row.deal_done,
                        v_row.hubspot_contact_id, v_row.hubspot_deal_id;
  else
    update public.form_submissions set status = 'processing', claimed_at = now() where id = v_row.id;
    return query select v_row.id, 'resume'::text, v_row.contact_done, v_row.deal_done,
                        v_row.hubspot_contact_id, v_row.hubspot_deal_id;
  end if;
end $$;
