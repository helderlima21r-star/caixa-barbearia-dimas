-- Sincronização automática com o Mercado Pago. Rode no SQL Editor depois do schema.sql.
alter table public.lancamentos add column if not exists mp_payment_id text;
create unique index if not exists lancamentos_mp_payment on public.lancamentos (mp_payment_id) where mp_payment_id is not null;

-- Roda a função mp-sync a cada 2 minutos.
-- Antes de rodar, troque CHAVE_SECRETA_DO_SYNC pelo mesmo valor do segredo SYNC_SECRET das Edge Functions.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('mp-sync') where exists (select 1 from cron.job where jobname = 'mp-sync');
select cron.schedule('mp-sync', '*/2 * * * *', $$
  select net.http_post(
    url := 'https://lfeynrvmttpjlrpaygft.supabase.co/functions/v1/mp-sync',
    headers := jsonb_build_object('Content-Type','application/json','x-sync-secret','CHAVE_SECRETA_DO_SYNC'),
    body := '{}'::jsonb
  );
$$);
