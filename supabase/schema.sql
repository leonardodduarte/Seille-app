-- Banco de dados do app Seille. Rode tudo de uma vez no Supabase: SQL Editor → New query → colar → Run.

-- Quem pode usar o app (e-mails das pessoas da Seille)
create table if not exists public.membros (email text primary key);

-- Todos os registros do app (pedidos, peças, custos, funcionárias, coleções...)
create table if not exists public.docs (
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);

alter table public.membros enable row level security;
alter table public.docs enable row level security;

create or replace function public.eh_membro() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.membros where lower(email) = lower(auth.jwt() ->> 'email'))
$$;

drop policy if exists "membro ve o proprio cadastro" on public.membros;
create policy "membro ve o proprio cadastro" on public.membros
  for select to authenticated using (lower(email) = lower(auth.jwt() ->> 'email'));

drop policy if exists "membros usam os dados" on public.docs;
create policy "membros usam os dados" on public.docs
  for all to authenticated using (public.eh_membro()) with check (public.eh_membro());

-- Atualização em tempo real entre celulares
alter table public.docs replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- Pasta privada para comprovantes, holerites e contas
insert into storage.buckets (id, name, public) values ('comprovantes', 'comprovantes', false)
  on conflict (id) do nothing;

drop policy if exists "membros usam os comprovantes" on storage.objects;
create policy "membros usam os comprovantes" on storage.objects
  for all to authenticated
  using (bucket_id = 'comprovantes' and public.eh_membro())
  with check (bucket_id = 'comprovantes' and public.eh_membro());

-- TROQUE pelos e-mails de vocês dois (os mesmos que vão usar para entrar no app)
insert into public.membros (email) values
  ('seu-email@exemplo.com'),
  ('email-da-sua-esposa@exemplo.com')
on conflict do nothing;
