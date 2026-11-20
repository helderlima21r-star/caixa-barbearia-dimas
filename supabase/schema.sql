-- Caixa da Barbearia: tabelas e regras de acesso.
-- Rode este arquivo uma vez no Supabase: SQL Editor → New query → cole tudo → Run.
-- Cada conta só enxerga e altera os próprios dados (Row Level Security).

create table if not exists public.lancamentos (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dia         date not null,
  hora        text not null,
  tipo        text not null check (tipo in ('servico','produto')),
  nome        text not null,
  ref         text,
  valor       numeric(10,2) not null check (valor >= 0),
  qtd         integer not null default 1 check (qtd > 0),
  pagamento   text,
  exemplo     boolean not null default false,
  criado_em   timestamptz not null default now()
);
create index if not exists lancamentos_owner_dia on public.lancamentos (owner, dia);

create table if not exists public.produtos (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome        text not null,
  preco       numeric(10,2) not null default 0 check (preco >= 0),
  estoque     integer not null default 0 check (estoque >= 0),
  minimo      integer not null default 3 check (minimo >= 0),
  exemplo     boolean not null default false,
  criado_em   timestamptz not null default now()
);

create table if not exists public.servicos (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome        text not null,
  preco       numeric(10,2) not null default 0 check (preco >= 0),
  ordem       integer not null default 0
);

alter table public.lancamentos enable row level security;
alter table public.produtos    enable row level security;
alter table public.servicos    enable row level security;

drop policy if exists "dono" on public.lancamentos;
drop policy if exists "dono" on public.produtos;
drop policy if exists "dono" on public.servicos;
create policy "dono" on public.lancamentos for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "dono" on public.produtos    for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "dono" on public.servicos    for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- Libera as tabelas para usuários logados (o RLS acima limita cada um aos próprios dados).
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.lancamentos, public.produtos, public.servicos to authenticated;
revoke all on public.lancamentos, public.produtos, public.servicos from anon;

-- Venda de produto: grava o lançamento e baixa o estoque juntos, sem deixar ficar negativo.
create or replace function public.vender_produto(p_produto uuid, p_qtd integer, p_pagamento text, p_dia date, p_hora text)
returns public.lancamentos
language plpgsql security invoker as $$
declare prod public.produtos; novo public.lancamentos;
begin
  update public.produtos set estoque = estoque - p_qtd
   where id = p_produto and owner = auth.uid() and estoque >= p_qtd
   returning * into prod;
  if not found then raise exception 'estoque_insuficiente'; end if;
  insert into public.lancamentos (dia, hora, tipo, nome, ref, valor, qtd, pagamento)
  values (p_dia, p_hora, 'produto', prod.nome, prod.id::text, prod.preco, p_qtd, p_pagamento)
  returning * into novo;
  return novo;
end $$;

-- Apagar um lançamento de produto devolve a quantidade ao estoque.
create or replace function public.apagar_lancamento(p_id uuid)
returns void
language plpgsql security invoker as $$
declare l public.lancamentos;
begin
  delete from public.lancamentos where id = p_id and owner = auth.uid() returning * into l;
  if found and l.tipo = 'produto' and l.ref is not null then
    update public.produtos set estoque = estoque + l.qtd where id::text = l.ref and owner = auth.uid();
  end if;
end $$;

grant execute on function public.vender_produto(uuid, integer, text, date, text) to authenticated;
grant execute on function public.apagar_lancamento(uuid) to authenticated;
revoke execute on function public.vender_produto(uuid, integer, text, date, text) from anon, public;
revoke execute on function public.apagar_lancamento(uuid) from anon, public;
