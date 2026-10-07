-- Phase 3: no duplicate roll-up after linking, pruning, activity counts, demo reset and seed.

-- Linking only needs a roll-up if none is already queued or running. A running roll-up that read the
-- customer before the link committed requeues itself (requeue_outbox), so nothing is lost.
-- (Order changes still always enqueue: a running roll-up may have read the totals before the change.)
create function private.enqueue_rollup_unless_active(p_customer uuid) returns void
language sql as $$
  insert into public.sync_outbox (kind, customer_id)
  select 'rollup', p_customer
   where not exists (select 1 from public.sync_outbox
                      where kind = 'rollup' and customer_id = p_customer and status in ('pending', 'processing'))
  on conflict (kind, customer_id) where status = 'pending' do nothing
$$;

create or replace function public.link_customer(p_customer uuid, p_contact_id bigint)
returns void
language plpgsql as $$
begin
  update public.customers set hubspot_contact_id = p_contact_id where id = p_customer;
  perform private.enqueue_rollup_unless_active(p_customer);
end $$;

create or replace function public.apply_hubspot_contact(
  p_contact_id bigint, p_email text, p_first_name text, p_last_name text,
  p_phone text, p_lifecycle_stage text, p_modified timestamptz)
returns text
language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from public.customers where hubspot_contact_id = p_contact_id for update;

  if v_id is null and p_email is not null then
    select id into v_id from public.customers
     where lower(email) = lower(p_email) and hubspot_contact_id is null
     for update;
    if v_id is not null then
      update public.customers set hubspot_contact_id = p_contact_id where id = v_id;
      perform private.enqueue_rollup_unless_active(v_id);
    end if;
  end if;

  if v_id is null then
    insert into public.customers (hubspot_contact_id, email, first_name, last_name, phone,
                                  lifecycle_stage, hs_last_modified, updated_by)
    values (p_contact_id, p_email, p_first_name, p_last_name, p_phone,
            p_lifecycle_stage, p_modified, 'hubspot');
    return 'inserted';
  end if;

  update public.customers
     set email = p_email, first_name = p_first_name, last_name = p_last_name, phone = p_phone,
         lifecycle_stage = p_lifecycle_stage, hs_last_modified = p_modified,
         updated_by = 'hubspot', deleted_at = null
   where id = v_id
     and (hs_last_modified is null or hs_last_modified < p_modified);

  return case when found then 'updated' else 'stale' end;
end $$;

-- Daily job: retention (ARCHITECTURE §10 step 3).
create function public.prune_old_rows()
returns jsonb
language plpgsql as $$
declare
  v_log int; v_inbox int; v_outbox int; v_rate int; v_forms int;
begin
  delete from public.sync_log where at < now() - interval '30 days';
  get diagnostics v_log = row_count;
  delete from public.sync_inbox where status in ('done', 'skipped') and received_at < now() - interval '30 days';
  get diagnostics v_inbox = row_count;
  delete from public.sync_outbox where status in ('done', 'skipped') and created_at < now() - interval '30 days';
  get diagnostics v_outbox = row_count;
  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_rate = row_count;
  delete from public.form_submissions where created_at < now() - interval '30 days';
  get diagnostics v_forms = row_count;
  return jsonb_build_object('sync_log', v_log, 'inbox', v_inbox, 'outbox', v_outbox,
                            'rate_limits', v_rate, 'form_submissions', v_forms);
end $$;

-- Activity page: parked jobs that need a human.
create function public.dead_job_count()
returns integer
language sql stable as $$
  select (select count(*) from public.sync_inbox where status = 'dead')::int
       + (select count(*) from public.sync_outbox where status = 'dead')::int
$$;

-- Demo reset, Supabase half (R12). The one sanctioned hard delete (PRD §5). Sync triggers are paused
-- for this transaction so deleting orders queues no roll-ups for customers about to disappear.
create function public.demo_reset_supabase()
returns jsonb
language plpgsql as $$
declare
  v_orders int; v_customers int;
begin
  perform set_config('app.sync_paused', 'on', true);
  delete from public.orders where true;
  get diagnostics v_orders = row_count;
  delete from public.sync_outbox where true;
  delete from public.sync_inbox where true;
  delete from public.customers where true;
  get diagnostics v_customers = row_count;
  delete from public.form_submissions where true;
  insert into public.sync_log (direction, action, outcome) values ('system', 'demo_reset', 'cleared');
  return jsonb_build_object('orders', v_orders, 'customers', v_customers);
end $$;

-- Demo seed: customers already linked to the HubSpot contacts the reset script just created.
-- updated_by = 'hubspot' means no link_contact work; inserting orders queues roll-ups as normal.
-- p_customers: [{hubspot_contact_id, email, first_name, last_name, lifecycle_stage, hs_last_modified,
--                orders: [{order_number, ordered_at, total_cents, status}]}]
create function public.demo_seed(p_customers jsonb)
returns jsonb
language plpgsql as $$
declare
  c jsonb;
  v_id uuid;
  v_customers int := 0;
  v_orders int := 0;
begin
  for c in select * from jsonb_array_elements(p_customers) loop
    insert into public.customers (hubspot_contact_id, email, first_name, last_name, lifecycle_stage,
                                  hs_last_modified, updated_by)
    values ((c->>'hubspot_contact_id')::bigint, c->>'email', c->>'first_name', c->>'last_name',
            c->>'lifecycle_stage', (c->>'hs_last_modified')::timestamptz, 'hubspot')
    returning id into v_id;
    v_customers := v_customers + 1;

    insert into public.orders (order_number, customer_id, ordered_at, total_cents, status)
    select o->>'order_number', v_id, (o->>'ordered_at')::timestamptz, (o->>'total_cents')::int, o->>'status'
      from jsonb_array_elements(coalesce(c->'orders', '[]'::jsonb)) o;
    v_orders := v_orders + (select jsonb_array_length(coalesce(c->'orders', '[]'::jsonb)));
  end loop;
  insert into public.sync_log (direction, action, outcome) values ('system', 'demo_seed', v_customers || ' customers');
  return jsonb_build_object('customers', v_customers, 'orders', v_orders);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.link_customer(uuid, bigint)',
    'public.apply_hubspot_contact(bigint, text, text, text, text, text, timestamptz)',
    'public.prune_old_rows()', 'public.dead_job_count()',
    'public.demo_reset_supabase()', 'public.demo_seed(jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
grant execute on function private.enqueue_rollup_unless_active(uuid) to service_role;
