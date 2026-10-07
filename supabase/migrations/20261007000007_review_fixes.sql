-- Fixes from the pre-deploy code review.

-- (1) A delete must win over a fetch that was already in flight: move the guard timestamp forward,
--     so an older snapshot applied afterwards is 'stale' and cannot un-delete or restore personal data.
--     A genuine restore happens later in HubSpot, so its lastmodifieddate passes the guard.
create or replace function public.apply_hubspot_delete(p_contact_id bigint)
returns text
language plpgsql as $$
begin
  update public.customers
     set deleted_at = coalesce(deleted_at, now()), email = null, first_name = null,
         last_name = null, phone = null, updated_by = 'hubspot',
         hs_last_modified = greatest(coalesce(hs_last_modified, '-infinity'::timestamptz), now())
   where hubspot_contact_id = p_contact_id;
  return case when found then 'deleted' else 'unknown' end;
end $$;

-- (2) Hand claimed-but-unstarted rows back when a worker runs out of time, without using an attempt.
create function public.release_jobs(p_queue text, p_ids bigint[])
returns void
language plpgsql as $$
begin
  if p_queue = 'inbox' then
    update public.sync_inbox
       set status = 'pending', claimed_at = null, attempts = greatest(attempts - 1, 0)
     where id = any(p_ids) and status = 'processing';
  elsif p_queue = 'outbox' then
    -- A newer pending row for the same (kind, customer) makes this one redundant.
    update public.sync_outbox o
       set status = 'skipped', processed_at = now()
     where o.id = any(p_ids) and o.status = 'processing'
       and exists (select 1 from public.sync_outbox p
                    where p.kind = o.kind and p.customer_id = o.customer_id and p.status = 'pending');
    update public.sync_outbox
       set status = 'pending', claimed_at = null, attempts = greatest(attempts - 1, 0)
     where id = any(p_ids) and status = 'processing';
  else
    raise exception 'release_jobs: unknown queue %', p_queue;
  end if;
end $$;

-- (3) requeue_outbox: a pending row inserted between the check and the update must not turn this
--     job into a unique-violation 'dead' row; it simply makes this one redundant.
create or replace function public.requeue_outbox(p_id bigint, p_delay_seconds integer default 60)
returns text
language plpgsql as $$
declare
  v_job public.sync_outbox;
begin
  select * into v_job from public.sync_outbox where id = p_id for update;
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

revoke all on function public.release_jobs(text, bigint[]) from public, anon, authenticated;
grant execute on function public.release_jobs(text, bigint[]) to service_role;
