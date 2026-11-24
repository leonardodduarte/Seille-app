-- Perfis de acesso ao app. Aplicado sozinho pelo GitHub (workflow "Publicar funções"); pode rodar de novo sem problema.
--  completo: vê e muda tudo (quem já estava na lista continua assim)
--  pedidos:  vê só o Painel e os Pedidos; pode atualizar pedidos, mais nada
alter table public.membros add column if not exists perfil text not null default 'completo';

create or replace function public.perfil_membro() returns text
language sql stable security definer set search_path = public as $$
  select perfil from public.membros where lower(email) = lower(auth.jwt() ->> 'email') limit 1
$$;

-- o que cada perfil pode ler
create or replace function public.pode_ler(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.perfil_membro()
    when 'completo' then true
    when 'pedidos' then c = any (array['vendas','config','metas','colecoes'])
    else false end
$$;

-- o que cada perfil pode gravar
create or replace function public.pode_gravar(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.perfil_membro()
    when 'completo' then true
    when 'pedidos' then c = 'vendas'
    else false end
$$;

drop policy if exists "membros usam os dados" on public.docs;
drop policy if exists "membros leem os dados" on public.docs;
drop policy if exists "membros incluem dados" on public.docs;
drop policy if exists "membros alteram dados" on public.docs;
drop policy if exists "membros apagam dados" on public.docs;
create policy "membros leem os dados" on public.docs for select to authenticated using (public.pode_ler(col));
create policy "membros incluem dados" on public.docs for insert to authenticated with check (public.pode_gravar(col));
create policy "membros alteram dados" on public.docs for update to authenticated using (public.pode_gravar(col)) with check (public.pode_gravar(col));
create policy "membros apagam dados" on public.docs for delete to authenticated using (public.perfil_membro() = 'completo');

-- comprovantes, holerites e contas: só acesso completo
drop policy if exists "membros usam os comprovantes" on storage.objects;
create policy "membros usam os comprovantes" on storage.objects
  for all to authenticated
  using (bucket_id = 'comprovantes' and public.perfil_membro() = 'completo')
  with check (bucket_id = 'comprovantes' and public.perfil_membro() = 'completo');
