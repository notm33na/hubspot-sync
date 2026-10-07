-- Atomic sync operations called by the Vercel workers (ARCHITECTURE §4, §5).

-- Flow A: apply the current state of a HubSpot contact (fetched by the worker, never taken from the event).
-- Match on hubspot_contact_id, then on email among unlinked customers, else insert.
-- Writes only if HubSpot's modification time is newer, so parallel or out-of-order work cannot regress a row.
-- An email already held by a different linked customer raises unique_violation (the worker marks it dead).
create function public.apply_hubspot_contact(
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
      perform private.enqueue('rollup', v_id);
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
         updated_by = 'hubspot', deleted_at = null   -- the contact exists, so a restore clears the delete
   where id = v_id
     and (hs_last_modified is null or hs_last_modified < p_modified);

  return case when found then 'updated' else 'stale' end;
end $$;

-- Flow A: contact deleted (or privacy-deleted, or 404 on fetch). Orders are kept.
create function public.apply_hubspot_delete(p_contact_id bigint)
returns text
language plpgsql as $$
begin
  update public.customers
     set deleted_at = coalesce(deleted_at, now()), email = null, first_name = null,
         last_name = null, phone = null, updated_by = 'hubspot'
   where hubspot_contact_id = p_contact_id;
  return case when found then 'deleted' else 'unknown' end;
end $$;

-- Flow A: HubSpot merged p_old_id into p_new_id.
create function public.apply_hubspot_merge(p_old_id bigint, p_new_id bigint)
returns text
language plpgsql as $$
declare
  v_old uuid;
  v_new uuid;
begin
  select id into v_old from public.customers where hubspot_contact_id = p_old_id for update;
  select id into v_new from public.customers where hubspot_contact_id = p_new_id for update;

  if v_old is null then
    return 'unknown';
  elsif v_new is null then
    update public.customers set hubspot_contact_id = p_new_id where id = v_old;
    return 'repointed';
  end if;

  update public.orders set customer_id = v_new where customer_id = v_old;
  update public.customers
     set hubspot_contact_id = null, deleted_at = now(), email = null, first_name = null,
         last_name = null, phone = null, updated_by = 'hubspot'
   where id = v_old;
  perform private.enqueue('rollup', v_new);
  return 'merged';
end $$;

-- Flow B: store the HubSpot ID found or created for an app-made customer, then queue its roll-up.
create function public.link_customer(p_customer uuid, p_contact_id bigint)
returns void
language plpgsql as $$
begin
  update public.customers set hubspot_contact_id = p_contact_id where id = p_customer;
  perform private.enqueue('rollup', p_customer);
end $$;

-- Flow B: roll-up values for one customer. Cancelled orders are excluded.
create function public.compute_rollup(p_customer uuid)
returns table (hubspot_contact_id bigint, is_deleted boolean, total_orders integer,
               lifetime_value_cents bigint, last_order_date date)
language sql stable as $$
  select c.hubspot_contact_id,
         c.deleted_at is not null,
         count(o.id)::integer,
         coalesce(sum(o.total_cents), 0)::bigint,
         max(o.ordered_at)::date
    from public.customers c
    left join public.orders o on o.customer_id = c.id and o.status <> 'cancelled'
   where c.id = p_customer
   group by c.id
$$;

-- Card: one page of a contact's orders, newest first.
create function public.orders_for_contact(p_contact_id bigint, p_limit integer, p_offset integer)
returns table (order_number text, ordered_at timestamptz, total_cents integer, currency char(3), status text)
language sql stable as $$
  select o.order_number, o.ordered_at, o.total_cents, o.currency, o.status
    from public.orders o
    join public.customers c on c.id = o.customer_id
   where c.hubspot_contact_id = p_contact_id
   order by o.ordered_at desc, o.order_number desc
   limit p_limit offset p_offset
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.apply_hubspot_contact(bigint, text, text, text, text, text, timestamptz)',
    'public.apply_hubspot_delete(bigint)', 'public.apply_hubspot_merge(bigint, bigint)',
    'public.link_customer(uuid, bigint)', 'public.compute_rollup(uuid)',
    'public.orders_for_contact(bigint, integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
