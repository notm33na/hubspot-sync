-- "There is work" signal to Vercel /api/drain (ARCHITECTURE §6).
-- The URL and bearer secret live in Supabase Vault and are created by hand, never in migrations:
--   select vault.create_secret('https://<vercel-domain>/api/drain', 'drain_url');
--   select vault.create_secret('<random 32+ chars>', 'drain_secret');
-- Until both exist, the signal is a silent no-op (so local development works without them).

create extension if not exists supabase_vault with schema vault;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- SECURITY DEFINER: the writing role cannot read vault.decrypted_secrets itself.
create function private.signal_drain() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'drain_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'drain_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  -- pg_net queues the request and sends it after the transaction commits.
  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret,
                                  'Content-Type', 'application/json'),
    timeout_milliseconds := 5000
  );
end $$;

revoke all on function private.signal_drain() from public, anon, authenticated;

create function private.outbox_signal_drain() returns trigger
language plpgsql as $$
begin
  if not private.sync_paused() then
    perform private.signal_drain();
  end if;
  return null;
end $$;

-- Once per statement: a burst of order changes sends one signal, not one per row.
create trigger outbox_signal_drain
  after insert on public.sync_outbox
  for each statement execute function private.outbox_signal_drain();

-- Safety net: retries, backoff and anything a lost signal missed (also keeps the project active).
select cron.schedule('drain-every-minute', '* * * * *', $$select private.signal_drain()$$);
