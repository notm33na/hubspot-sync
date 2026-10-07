-- Fixes from the second code review.

-- (1) Stamp a delete with HubSpot's time, not the processing time. The server clock blocked a genuine
--     restore whenever the delete was processed after the restore had already happened.
--     Callers pass the deletion event's occurredAt (or the contact's lastmodifieddate); the default now()
--     is only right on the 404 path, where "gone as of now" is exactly what was observed.
drop function public.apply_hubspot_delete(bigint);
create function public.apply_hubspot_delete(p_contact_id bigint, p_deleted_at timestamptz default now())
returns text
language plpgsql as $$
begin
  update public.customers
     set deleted_at = coalesce(deleted_at, p_deleted_at), email = null, first_name = null,
         last_name = null, phone = null, updated_by = 'hubspot',
         hs_last_modified = greatest(coalesce(hs_last_modified, '-infinity'::timestamptz), p_deleted_at)
   where hubspot_contact_id = p_contact_id;
  return case when found then 'deleted' else 'unknown' end;
end $$;
revoke all on function public.apply_hubspot_delete(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_hubspot_delete(bigint, timestamptz) to service_role;

-- (2) release_jobs: row by row, so two claimed rows for the same (kind, customer), or a pending row
--     inserted meanwhile, make the extra row 'skipped' instead of raising a unique violation.
create or replace function public.release_jobs(p_queue text, p_ids bigint[])
returns void
language plpgsql as $$
declare
  v_id bigint;
begin
  if p_queue = 'inbox' then
    update public.sync_inbox
       set status = 'pending', claimed_at = null, attempts = greatest(attempts - 1, 0)
     where id = any(p_ids) and status = 'processing';
  elsif p_queue = 'outbox' then
    foreach v_id in array p_ids loop
      begin
        update public.sync_outbox
           set status = 'pending', claimed_at = null, attempts = greatest(attempts - 1, 0)
         where id = v_id and status = 'processing';
      exception when unique_violation then
        update public.sync_outbox set status = 'skipped', processed_at = now() where id = v_id;
      end;
    end loop;
  else
    raise exception 'release_jobs: unknown queue %', p_queue;
  end if;
end $$;

-- (3) A roll-up waiting for a link is only parked when linking itself has been parked;
--     a slow-but-progressing link (backing off during an outage) keeps it waiting.
create or replace function public.requeue_outbox(p_id bigint, p_delay_seconds integer default 60)
returns text
language plpgsql as $$
declare
  v_job public.sync_outbox;
begin
  select * into v_job from public.sync_outbox where id = p_id for update;
  if exists (select 1 from public.sync_outbox
              where kind = 'link_contact' and customer_id = v_job.customer_id and status = 'dead') then
    update public.sync_outbox
       set status = 'dead', last_error = 'linking this customer to HubSpot failed (see its link_contact job)'
     where id = p_id;
    return 'dead';
  end if;
  if exists (select 1 from public.sync_outbox
              where kind = v_job.kind and customer_id = v_job.customer_id
                and status = 'pending' and id <> p_id) then
    update public.sync_outbox set status = 'skipped', processed_at = now() where id = p_id;
    return 'skipped';
  end if;
  begin
    update public.sync_outbox
       set status = 'pending', attempts = greatest(attempts - 1, 0),
           next_attempt_at = now() + make_interval(secs => p_delay_seconds)
     where id = p_id;
  exception when unique_violation then
    update public.sync_outbox set status = 'skipped', processed_at = now() where id = p_id;
    return 'skipped';
  end;
  return 'pending';
end $$;
