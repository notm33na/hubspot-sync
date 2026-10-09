-- Smoke test 2026-10-09 (docs/SMOKE-TEST.md, observation 3): a roll-up PATCH moves HubSpot's lastmodifieddate
-- without changing any field we mirror, so the next fetch of that contact (daily reconcile) rewrote an identical row.

-- updated_at means "the data changed": an update that only moves hs_last_modified (or nothing) keeps it.
create or replace function private.touch_updated_at() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - 'updated_at' - 'hs_last_modified') is distinct from (to_jsonb(old) - 'updated_at' - 'hs_last_modified') then
    new.updated_at := now();
  end if;
  return new;
end $$;

-- Same signature and body as 20261007000006, plus an 'unchanged' outcome. An identical newer state still advances
-- hs_last_modified: the out-of-order guard needs it, or a late fetch of an intermediate state could win.
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
     set hs_last_modified = p_modified
   where id = v_id
     and (hs_last_modified is null or hs_last_modified < p_modified)
     and email is not distinct from p_email and first_name is not distinct from p_first_name
     and last_name is not distinct from p_last_name and phone is not distinct from p_phone
     and lifecycle_stage is not distinct from p_lifecycle_stage
     and updated_by = 'hubspot' and deleted_at is null;
  if found then return 'unchanged'; end if;

  update public.customers
     set email = p_email, first_name = p_first_name, last_name = p_last_name, phone = p_phone,
         lifecycle_stage = p_lifecycle_stage, hs_last_modified = p_modified,
         updated_by = 'hubspot', deleted_at = null
   where id = v_id
     and (hs_last_modified is null or hs_last_modified < p_modified);

  return case when found then 'updated' else 'stale' end;
end $$;
