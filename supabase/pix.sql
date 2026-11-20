-- Cobrança Pix pelo Mercado Pago. Rode depois do schema.sql (SQL Editor → New query → Run).
create table if not exists public.cobrancas (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  servico_nome  text not null,
  servico_ref   text,
  valor         numeric(10,2) not null check (valor > 0),
  status        text not null default 'pendente' check (status in ('pendente','pago','cancelado','expirado')),
  mp_payment_id text,
  qr_code       text,
  qr_base64     text,
  lancamento_id uuid references public.lancamentos(id) on delete set null,
  criado_em     timestamptz not null default now(),
  pago_em       timestamptz
);
create index if not exists cobrancas_owner on public.cobrancas (owner, criado_em desc);
alter table public.cobrancas enable row level security;
drop policy if exists "dono le" on public.cobrancas;
drop policy if exists "dono cancela" on public.cobrancas;
-- O app só lê as próprias cobranças e pode cancelar uma pendente.
-- Quem cria e marca como paga é o servidor (funções), com a chave de serviço.
create policy "dono le" on public.cobrancas for select to authenticated using (owner = auth.uid());
create policy "dono cancela" on public.cobrancas for update to authenticated
  using (owner = auth.uid() and status = 'pendente') with check (owner = auth.uid() and status = 'cancelado');
grant select, update (status) on public.cobrancas to authenticated;
revoke all on public.cobrancas from anon;
