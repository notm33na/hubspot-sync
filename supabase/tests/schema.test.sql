-- Schema behaviour tests. Run against a database with all migrations applied:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/schema.test.sql
-- Everything runs in one transaction and is rolled back. Any failed check raises and stops the run.
\set QUIET on
begin;

create function pg_temp.check(p_ok boolean, p_name text) returns void
language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name;
end $$;

-- --------------------------------------------------------------- access
do $$
begin
  set local role anon;
  begin
    perform 1 from public.customers;
    reset role;
    perform pg_temp.check(false, 'anon cannot read customers');
  exception when insufficient_privilege then
    reset role;
    perform pg_temp.check(true, 'anon cannot read customers');
  end;
end $$;

do $$
begin
  set local role anon;
  begin
    perform public.claim_outbox(1);
    reset role;
    perform pg_temp.check(false, 'anon cannot call claim_outbox');
  exception when insufficient_privilege then
    reset role;
    perform pg_temp.check(true, 'anon cannot call claim_outbox');
  end;
end $$;

select pg_temp.check(
  (select bool_and(relrowsecurity) from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'),
  'RLS enabled on every public table');

-- The server role must be able to do everything the workers do (regression: 42501 on claim_outbox).
do $$
begin
  set local role service_role;
  insert into public.customers (id, email, updated_by)
  values ('00000000-0000-0000-0000-0000000000ff', 'svc@example.com', 'app');          -- fires enqueue trigger
  insert into public.orders (order_number, customer_id, ordered_at, total_cents, status)
  values ('SVC-1', '00000000-0000-0000-0000-0000000000ff', now(), 100, 'shipped');    -- fires rollup trigger
  perform public.claim_outbox(10);
  perform public.claim_inbox(10);
  perform * from public.compute_rollup('00000000-0000-0000-0000-0000000000ff');
  perform public.hit_rate_limit('svc', 60, 5);
  insert into public.sync_log (direction, action, outcome) values ('system', 'test', 'ok');
  reset role;
  perform pg_temp.check(true, 'service_role can run triggers, RPCs and writes');
  delete from public.orders where order_number = 'SVC-1';
  delete from public.sync_outbox where customer_id = '00000000-0000-0000-0000-0000000000ff';
  delete from public.customers where id = '00000000-0000-0000-0000-0000000000ff';
end $$;

-- ------------------------------------------------------------- enqueue
insert into public.customers (id, email, first_name, updated_by)
values ('00000000-0000-0000-0000-00000000000a', 'app.made@example.com', 'App', 'app'),
       ('00000000-0000-0000-0000-00000000000b', 'mirror@example.com', 'Mirror', 'hubspot');

select pg_temp.check(
  (select count(*) = 1 from public.sync_outbox
    where kind = 'link_contact' and customer_id = '00000000-0000-0000-0000-00000000000a'),
  'app-created customer enqueues link_contact');
select pg_temp.check(
  not exists (select 1 from public.sync_outbox where customer_id = '00000000-0000-0000-0000-00000000000b'),
  'hubspot-mirrored customer enqueues nothing (R7)');

do $$
begin
  insert into public.customers (email, updated_by) values ('APP.MADE@example.com', 'app');
  perform pg_temp.check(false, 'email unique case-insensitively');
exception when unique_violation then
  perform pg_temp.check(true, 'email unique case-insensitively');
end $$;

insert into public.orders (order_number, customer_id, ordered_at, total_cents, status)
select 'T-' || g, '00000000-0000-0000-0000-00000000000b', now(), 1000 * g, 'shipped'
  from generate_series(1, 3) g;

select pg_temp.check(
  (select count(*) = 1 from public.sync_outbox
    where kind = 'rollup' and customer_id = '00000000-0000-0000-0000-00000000000b' and status = 'pending'),
  'burst of 3 orders coalesces into one pending rollup');

update public.orders set customer_id = '00000000-0000-0000-0000-00000000000a' where order_number = 'T-1';
select pg_temp.check(
  (select count(*) = 1 from public.sync_outbox
    where kind = 'rollup' and customer_id = '00000000-0000-0000-0000-00000000000a'),
  'moving an order enqueues rollup for the new customer too');

do $$
begin
  delete from public.customers where id = '00000000-0000-0000-0000-00000000000b';
  perform pg_temp.check(false, 'customer with orders cannot be hard-deleted');
exception when foreign_key_violation then
  perform pg_temp.check(true, 'customer with orders cannot be hard-deleted');
end $$;

-- ------------------------------------------------------------ pause flag
delete from public.sync_outbox;
do $$
begin
  set local app.sync_paused = 'on';
  insert into public.orders (order_number, customer_id, ordered_at, total_cents, status)
  values ('T-P', '00000000-0000-0000-0000-00000000000b', now(), 500, 'processing');
  insert into public.customers (email, updated_by) values ('paused@example.com', 'app');
  perform pg_temp.check(not exists (select 1 from public.sync_outbox),
                        'app.sync_paused suppresses all enqueueing');
  set local app.sync_paused = '';
end $$;

-- ------------------------------------------------------------- claiming
delete from public.sync_outbox;
insert into public.sync_outbox (kind, customer_id)
values ('rollup', '00000000-0000-0000-0000-00000000000a'),
       ('rollup', '00000000-0000-0000-0000-00000000000b');

select pg_temp.check((select count(*) = 2 from public.claim_outbox(20)), 'claim returns due rows');
select pg_temp.check(
  (select bool_and(status = 'processing' and attempts = 1) from public.sync_outbox),
  'claimed rows are processing with attempts = 1');
select pg_temp.check((select count(*) = 0 from public.claim_outbox(20)), 'processing rows are not claimed twice');

update public.sync_outbox set claimed_at = now() - interval '10 minutes'
 where customer_id = '00000000-0000-0000-0000-00000000000a';
select pg_temp.check(
  (select count(*) = 1 and min(attempts) = 2 from public.claim_outbox(20)),
  'stale processing row (>5 min) is reclaimed');

-- --------------------------------------------------------------- failure
select pg_temp.check(
  public.fail_job('outbox', (select id from public.sync_outbox where customer_id = '00000000-0000-0000-0000-00000000000b'),
                  'HTTP 503') = 'failed',
  'transient failure -> failed');
select pg_temp.check(
  (select next_attempt_at > now() from public.sync_outbox where customer_id = '00000000-0000-0000-0000-00000000000b'),
  'failed row backs off');
select pg_temp.check(
  public.fail_job('outbox', (select id from public.sync_outbox where customer_id = '00000000-0000-0000-0000-00000000000a'),
                  'HTTP 400 bad property', true) = 'dead',
  'permanent failure -> dead');

update public.sync_outbox set attempts = 8, status = 'processing'
 where customer_id = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check(
  public.fail_job('outbox', (select id from public.sync_outbox where customer_id = '00000000-0000-0000-0000-00000000000b'),
                  'HTTP 503') = 'dead',
  '8th failure -> dead');

update public.sync_outbox set status = 'processing', attempts = 8, claimed_at = now() - interval '10 minutes', last_error = null
 where customer_id = '00000000-0000-0000-0000-00000000000b';
select count(*) from public.claim_outbox(20);
select pg_temp.check(
  (select status = 'dead' from public.sync_outbox where customer_id = '00000000-0000-0000-0000-00000000000b'),
  'abandoned row with no attempts left is parked as dead');

-- --------------------------------------------------------------- requeue
delete from public.sync_outbox;
insert into public.sync_outbox (kind, customer_id) values ('rollup', '00000000-0000-0000-0000-00000000000a');
select count(*) from public.claim_outbox(20);
select pg_temp.check(public.requeue_outbox((select id from public.sync_outbox), 60) = 'pending',
  'requeue returns row to pending');
-- Separate statement: a query in the same statement would see the pre-update snapshot.
select pg_temp.check(
  (select status = 'pending' and attempts = 0 and next_attempt_at > now() from public.sync_outbox),
  'requeued row is delayed and gets its attempt back');

select count(*) from public.claim_outbox(20);  -- not due yet: claims nothing
update public.sync_outbox set next_attempt_at = now();
select count(*) from public.claim_outbox(20);
insert into public.sync_outbox (kind, customer_id) values ('rollup', '00000000-0000-0000-0000-00000000000a');
select pg_temp.check(
  public.requeue_outbox((select min(id) from public.sync_outbox), 60) = 'skipped',
  'requeue skips when a newer pending rollup exists');

-- ------------------------------------------------------------------ form
select pg_temp.check((select outcome = 'new'         from public.claim_form_submission('k1', 'a@example.com')), 'form: first submit is new');
select pg_temp.check((select outcome = 'in_progress' from public.claim_form_submission('k1', 'a@example.com')), 'form: concurrent resubmit is in_progress');
update public.form_submissions set claimed_at = now() - interval '3 minutes', contact_done = true, hubspot_contact_id = 42 where dedupe_key = 'k1';
select pg_temp.check(
  (select outcome = 'resume' and contact_done and hubspot_contact_id = 42 from public.claim_form_submission('k1', 'a@example.com')),
  'form: stale processing row resumes with step state');
update public.form_submissions set status = 'done', deal_done = true, hubspot_deal_id = 7 where dedupe_key = 'k1';
select pg_temp.check(
  (select outcome = 'done' and hubspot_deal_id = 7 from public.claim_form_submission('k1', 'a@example.com')),
  'form: done submission returns stored result');
update public.form_submissions set created_at = now() - interval '25 hours' where dedupe_key = 'k1';
select pg_temp.check((select outcome = 'new' from public.claim_form_submission('k1', 'a@example.com')), 'form: same key after 24 h is new');

-- ------------------------------------------------------------ rate limit
select pg_temp.check(
  public.hit_rate_limit('ip:abc', 3600, 2) and public.hit_rate_limit('ip:abc', 3600, 2)
  and not public.hit_rate_limit('ip:abc', 3600, 2),
  'rate limit allows 2 then blocks');

-- -------------------------------------------------------- sync functions
delete from public.sync_outbox;
-- Note: each action and its verification are separate statements (a statement sees its own start snapshot).
select pg_temp.check(
  public.apply_hubspot_contact(9001, 'new@example.com', 'New', 'Person', null, 'lead', '2026-10-01T10:00Z') = 'inserted',
  'apply: unknown contact is inserted');
select pg_temp.check((select updated_by = 'hubspot' from public.customers where hubspot_contact_id = 9001),
  'apply: inserted row is hubspot-owned');
select pg_temp.check(not exists (select 1 from public.sync_outbox), 'apply: insert enqueues nothing (R7)');
select pg_temp.check(
  public.apply_hubspot_contact(9001, 'new@example.com', 'Newer', 'Person', null, 'lead', '2026-10-01T11:00Z') = 'updated',
  'apply: newer state updates');
select pg_temp.check(
  public.apply_hubspot_contact(9001, 'new@example.com', 'Older', 'Person', null, 'lead', '2026-10-01T09:00Z') = 'stale',
  'apply: older state reports stale');
select pg_temp.check((select first_name = 'Newer' from public.customers where hubspot_contact_id = 9001),
  'apply: older state does not overwrite');
select pg_temp.check(
  public.apply_hubspot_contact(9002, 'APP.made@example.com', 'App', 'Linked', null, 'lead', '2026-10-01T10:00Z') = 'updated',
  'apply: unlinked customer with same email is updated');
select pg_temp.check(
  (select hubspot_contact_id = 9002 from public.customers where id = '00000000-0000-0000-0000-00000000000a'),
  'apply: ...and linked by email (case-insensitive)');
select pg_temp.check(
  exists (select 1 from public.sync_outbox where kind = 'rollup' and customer_id = '00000000-0000-0000-0000-00000000000a'),
  'apply: linking queues a rollup');

do $$
begin
  perform public.apply_hubspot_contact(9003, 'new@example.com', 'Dup', 'Email', null, 'lead', now());
  perform pg_temp.check(false, 'apply: email held by another linked contact raises');
exception when unique_violation then
  perform pg_temp.check(true, 'apply: email held by another linked contact raises');
end $$;

select pg_temp.check(public.apply_hubspot_delete(9001) = 'deleted', 'delete: known contact reports deleted');
select pg_temp.check(
  (select deleted_at is not null and email is null and first_name is null
     from public.customers where hubspot_contact_id = 9001),
  'delete: soft-deletes and clears PII');
select pg_temp.check(
  public.apply_hubspot_contact(9001, 'back@example.com', 'Back', 'Again', null, 'lead', '2026-10-02T10:00Z') = 'updated',
  'restore: later state applies');
select pg_temp.check((select deleted_at is null from public.customers where hubspot_contact_id = 9001),
  'restore: clears deleted_at');

update public.customers set hubspot_contact_id = 9000 where id = '00000000-0000-0000-0000-00000000000b';
delete from public.sync_outbox;
select pg_temp.check(public.apply_hubspot_merge(9000, 9002) = 'merged', 'merge: reports merged');
select pg_temp.check(
  not exists (select 1 from public.orders where customer_id = '00000000-0000-0000-0000-00000000000b')
  and (select deleted_at is not null and hubspot_contact_id is null
         from public.customers where id = '00000000-0000-0000-0000-00000000000b'),
  'merge: orders move to the survivor, duplicate is soft-deleted');
select pg_temp.check(
  exists (select 1 from public.sync_outbox where kind = 'rollup' and customer_id = '00000000-0000-0000-0000-00000000000a'),
  'merge: survivor gets a rollup');
select pg_temp.check(public.apply_hubspot_merge(9050, 9051) = 'unknown', 'merge: unknown contact is a no-op');

update public.orders set status = 'cancelled' where order_number = 'T-1';
select pg_temp.check(
  (select total_orders = 3 and lifetime_value_cents = 5500 and hubspot_contact_id = 9002 and not is_deleted
     from public.compute_rollup('00000000-0000-0000-0000-00000000000a')),
  'rollup: counts non-cancelled orders and sums cents');
select pg_temp.check(
  (select count(*) = 2 from public.orders_for_contact(9002, 2, 0))
  and (select count(*) = 2 from public.orders_for_contact(9002, 2, 2)),
  'card query pages through all 4 orders');

-- ---------------------------------------------------------- drain signal
delete from public.sync_outbox;
do $$
declare v_before bigint;
begin
  -- A live project already has the real secrets; hide them inside this (rolled-back) transaction.
  delete from vault.secrets where name in ('drain_url', 'drain_secret');
  select count(*) into v_before from net.http_request_queue;
  insert into public.sync_outbox (kind, customer_id) values ('rollup', '00000000-0000-0000-0000-00000000000b');
  perform pg_temp.check((select count(*) = v_before from net.http_request_queue),
                        'no vault secrets -> signal is a silent no-op');

  perform vault.create_secret('https://drain.invalid/api/drain', 'drain_url');
  perform vault.create_secret('test-secret', 'drain_secret');
  insert into public.sync_outbox (kind, customer_id) values ('rollup', '00000000-0000-0000-0000-00000000000a');
  perform pg_temp.check((select count(*) = v_before + 1 from net.http_request_queue),
                        'outbox insert queues one signal request');
  perform pg_temp.check(
    (select url = 'https://drain.invalid/api/drain' and headers->>'Authorization' = 'Bearer test-secret'
       from net.http_request_queue order by id desc limit 1),
    'signal uses vault URL and bearer secret');
end $$;

select pg_temp.check(
  exists (select 1 from cron.job where jobname = 'drain-every-minute' and schedule = '* * * * *'),
  'pg_cron drain job scheduled every minute');

-- ------------------------------------------------------------------ phase 3
delete from public.sync_outbox;
insert into public.customers (id, email, updated_by)
values ('00000000-0000-0000-0000-0000000000c1', 'link.me@example.com', 'hubspot');
insert into public.sync_outbox (kind, customer_id, status) values ('rollup', '00000000-0000-0000-0000-0000000000c1', 'processing');
select public.link_customer('00000000-0000-0000-0000-0000000000c1', 7001);
select pg_temp.check(
  (select count(*) = 1 from public.sync_outbox where customer_id = '00000000-0000-0000-0000-0000000000c1'),
  'link: no duplicate rollup while one is processing');
delete from public.sync_outbox;
select public.link_customer('00000000-0000-0000-0000-0000000000c1', 7001);
select pg_temp.check(
  (select count(*) = 1 from public.sync_outbox where customer_id = '00000000-0000-0000-0000-0000000000c1' and status = 'pending'),
  'link: queues a rollup when none is active');

insert into public.sync_outbox (kind, customer_id, status) values ('link_contact', '00000000-0000-0000-0000-0000000000c1', 'dead');
select pg_temp.check(public.dead_job_count() >= 1, 'dead_job_count counts parked jobs');

insert into public.sync_log (at, direction, action, outcome) values (now() - interval '40 days', 'system', 'old', 'x');
select pg_temp.check((public.prune_old_rows()->>'sync_log')::int >= 1, 'prune removes old sync_log rows');
select pg_temp.check(not exists (select 1 from public.sync_log where action = 'old'), 'prune: old row gone');

-- Reset and seed (wipes all data, so this runs last).
select pg_temp.check((public.demo_reset_supabase()->>'customers')::int >= 1, 'reset reports deleted customers');
select pg_temp.check(
  not exists (select 1 from public.customers) and not exists (select 1 from public.orders)
  and not exists (select 1 from public.sync_outbox),
  'reset leaves no customers, orders or queued work');
-- The reset's pause is transaction-local; in real use the seed is a separate transaction.
select set_config('app.sync_paused', '', true);
select pg_temp.check(
  (public.demo_seed('[{"hubspot_contact_id": 8001, "email": "seed@example.com", "first_name": "Sam",
     "last_name": "Seed", "lifecycle_stage": "customer", "hs_last_modified": "2026-10-07T00:00:00Z",
     "orders": [{"order_number": "S-1", "ordered_at": "2026-10-01T00:00:00Z", "total_cents": 1200, "status": "shipped"},
                {"order_number": "S-2", "ordered_at": "2026-10-03T00:00:00Z", "total_cents": 800, "status": "delivered"}]}]'::jsonb)
   ->>'orders')::int = 2,
  'seed inserts customers and orders');
select pg_temp.check(
  (select count(*) = 1 from public.sync_outbox where kind = 'rollup')
  and not exists (select 1 from public.sync_outbox where kind = 'link_contact'),
  'seed queues one rollup per customer and no link work');

\echo 'ALL SCHEMA TESTS PASSED'
rollback;
