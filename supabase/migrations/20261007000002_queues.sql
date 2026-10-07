-- Queue triggers and job functions (ARCHITECTURE §5, §6, §7).
-- Sync triggers are skipped when the transaction sets `app.sync_paused = on` (used by the demo reset).

create function private.sync_paused() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.sync_paused', true), '') = 'on'
$$;

create function private.enqueue(p_kind text, p_customer uuid) returns void
language sql as $$
  insert into public.sync_outbox (kind, customer_id)
  values (p_kind, p_customer)
  on conflict (kind, customer_id) where status = 'pending' do nothing
$$;

-- Any order change -> recompute roll-ups for the affected customer(s).
create function private.orders_enqueue_rollup() returns trigger
language plpgsql as $$
begin
  if private.sync_paused() then return null; end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform private.enqueue('rollup', new.customer_id);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.customer_id <> new.customer_id) then
    perform private.enqueue('rollup', old.customer_id);
  end if;
  return null;
end $$;

create trigger orders_enqueue_rollup
  after insert or update or delete on public.orders
  for each row execute function private.orders_enqueue_rollup();

-- Customers created here (not mirrored from HubSpot) need linking to a HubSpot contact.
-- Rows written by Flow A have updated_by = 'hubspot' and never enqueue (loop prevention, R7).
create function private.customers_enqueue_link() returns trigger
language plpgsql as $$
begin
  if private.sync_paused() then return null; end if;
  if new.updated_by = 'app' and new.hubspot_contact_id is null then
    perform private.enqueue('link_contact', new.id);
  end if;
  return null;
end $$;

create trigger customers_enqueue_link
  after insert on public.customers
  for each row execute function private.customers_enqueue_link();

-- ------------------------------------------------------------- job runner
-- Claiming counts as an attempt, so a row that crashes the worker cannot loop forever.
create function private.backoff(p_attempts integer) returns interval
language sql immutable as $$
  select case
    when p_attempts <= 1 then interval '1 minute'
    when p_attempts = 2  then interval '5 minutes'
    when p_attempts = 3  then interval '30 minutes'
    else interval '120 minutes'
  end
$$;

create function public.claim_inbox(p_limit integer default 20)
returns setof public.sync_inbox
language plpgsql as $$
begin
  -- Abandoned rows that already used every attempt are parked.
  update public.sync_inbox
     set status = 'dead', last_error = coalesce(last_error, 'abandoned while processing')
   where status = 'processing' and claimed_at < now() - interval '5 minutes' and attempts >= 8;

  return query
  update public.sync_inbox q
     set status = 'processing', claimed_at = now(), attempts = q.attempts + 1
   where q.id in (
     select id from public.sync_inbox
      where ((status in ('pending', 'failed') and next_attempt_at <= now())
          or (status = 'processing' and claimed_at < now() - interval '5 minutes'))
        and attempts < 8
      order by id
      limit p_limit
      for update skip locked)
  returning q.*;
end $$;

create function public.claim_outbox(p_limit integer default 20)
returns setof public.sync_outbox
language plpgsql as $$
begin
  update public.sync_outbox
     set status = 'dead', last_error = coalesce(last_error, 'abandoned while processing')
   where status = 'processing' and claimed_at < now() - interval '5 minutes' and attempts >= 8;

  return query
  update public.sync_outbox q
     set status = 'processing', claimed_at = now(), attempts = q.attempts + 1
   where q.id in (
     select id from public.sync_outbox
      where ((status in ('pending', 'failed') and next_attempt_at <= now())
          or (status = 'processing' and claimed_at < now() - interval '5 minutes'))
        and attempts < 8
      order by id
      limit p_limit
      for update skip locked)
  returning q.*;
end $$;

-- p_status: 'done' or 'skipped'.
create function public.finish_job(p_queue text, p_id bigint, p_status text)
returns void
language plpgsql as $$
begin
  if p_status not in ('done', 'skipped') then
    raise exception 'finish_job: invalid status %', p_status;
  end if;
  if p_queue = 'inbox' then
    update public.sync_inbox set status = p_status, processed_at = now(), last_error = null where id = p_id;
  elsif p_queue = 'outbox' then
    update public.sync_outbox set status = p_status, processed_at = now(), last_error = null where id = p_id;
  else
    raise exception 'finish_job: unknown queue %', p_queue;
  end if;
end $$;

-- Permanent errors (non-429 4xx) and the 8th failure are terminal: 'dead'. Otherwise back off.
create function public.fail_job(p_queue text, p_id bigint, p_error text, p_permanent boolean default false)
returns text
language plpgsql as $$
declare
  v_attempts integer;
  v_status   text;
begin
  if p_queue = 'inbox' then
    select attempts into v_attempts from public.sync_inbox where id = p_id;
  elsif p_queue = 'outbox' then
    select attempts into v_attempts from public.sync_outbox where id = p_id;
  else
    raise exception 'fail_job: unknown queue %', p_queue;
  end if;

  v_status := case when p_permanent or v_attempts >= 8 then 'dead' else 'failed' end;

  if p_queue = 'inbox' then
    update public.sync_inbox
       set status = v_status, last_error = left(p_error, 1000),
           next_attempt_at = now() + private.backoff(v_attempts)
     where id = p_id;
  else
    update public.sync_outbox
       set status = v_status, last_error = left(p_error, 1000),
           next_attempt_at = now() + private.backoff(v_attempts)
     where id = p_id;
  end if;
  return v_status;
end $$;

-- A roll-up for a customer that is not linked yet waits without using up attempts.
-- If a newer pending roll-up already exists, this one is redundant: skip it.
create function public.requeue_outbox(p_id bigint, p_delay_seconds integer default 60)
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
  update public.sync_outbox
     set status = 'pending', attempts = greatest(attempts - 1, 0),
         next_attempt_at = now() + make_interval(secs => p_delay_seconds)
   where id = p_id;
  return 'pending';
end $$;

-- ----------------------------------------------------------- form (R6)
-- Atomically decides what /api/form should do with a submission:
--   new         -> row created, run all steps
--   resume      -> stale or failed row reclaimed, continue from unfinished steps
--   in_progress -> another request is working on it (return 409)
--   done        -> return the stored result
create function public.claim_form_submission(p_key text, p_email text)
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
  elsif v_row.status = 'processing' and v_row.claimed_at > now() - interval '2 minutes' then
    return query select v_row.id, 'in_progress'::text, v_row.contact_done, v_row.deal_done,
                        v_row.hubspot_contact_id, v_row.hubspot_deal_id;
  else
    update public.form_submissions set status = 'processing', claimed_at = now() where id = v_row.id;
    return query select v_row.id, 'resume'::text, v_row.contact_done, v_row.deal_done,
                        v_row.hubspot_contact_id, v_row.hubspot_deal_id;
  end if;
end $$;

-- ----------------------------------------------------------- rate limits
-- Fixed windows. Returns true if this hit is allowed.
create function public.hit_rate_limit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count  integer;
begin
  insert into public.rate_limits as r (bucket, window_start, count)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set count = r.count + 1
  returning r.count into v_count;
  return v_count <= p_max;
end $$;

-- ---------------------------------------------------------------- grants
-- Server-only RPCs: callable by the service role, nobody else.
do $$
declare f text;
begin
  foreach f in array array[
    'public.claim_inbox(integer)', 'public.claim_outbox(integer)',
    'public.finish_job(text, bigint, text)', 'public.fail_job(text, bigint, text, boolean)',
    'public.requeue_outbox(bigint, integer)', 'public.claim_form_submission(text, text)',
    'public.hit_rate_limit(text, integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
