-- Fase 1: perfil do dev, status de curadoria e status de KYC da subconta.
-- A chave de API da subconta NÃO fica aqui (ADR-010): é do módulo payments (migração 0007).
create type public.dev_status as enum ('pending', 'approved', 'suspended');
create type public.kyc_status as enum ('not_started', 'pending', 'approved', 'rejected');

create table public.dev_profiles (
  user_id uuid primary key references public.users (id) on delete cascade,
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 60),
  display_name text not null check (char_length(display_name) between 2 and 80),
  bio text not null default '' check (char_length(bio) <= 2000),
  portfolio_links jsonb not null default '[]'::jsonb
    check (jsonb_typeof(portfolio_links) = 'array' and jsonb_array_length(portfolio_links) <= 10),
  status public.dev_status not null default 'pending',
  kyc_status public.kyc_status not null default 'not_started',
  provider_account_id text unique,
  wallet_id text,
  kyc_link text,
  escrow_enabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger dev_profiles_touch
  before update on public.dev_profiles
  for each row execute function public.touch_updated_at();

alter table public.dev_profiles enable row level security;

-- Privilégios mínimos por coluna: o dev nunca escreve status, KYC nem campos do provedor.
revoke all on public.dev_profiles from anon, authenticated;
grant select on public.dev_profiles to authenticated;
grant insert (user_id, slug, display_name, bio, portfolio_links) on public.dev_profiles to authenticated;
grant update (display_name, bio, portfolio_links) on public.dev_profiles to authenticated;
grant all on public.dev_profiles to service_role;

create policy dev_profiles_select_own on public.dev_profiles
  for select to authenticated using (user_id = auth.uid());
create policy dev_profiles_select_admin on public.dev_profiles
  for select to authenticated using (public.is_admin());

create policy dev_profiles_insert_own on public.dev_profiles
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and status = 'pending'
    and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'dev')
  );

create policy dev_profiles_update_own on public.dev_profiles
  for update to authenticated
  using (user_id = auth.uid() and status <> 'suspended')
  with check (user_id = auth.uid());

-- Vitrine pública: só devs aprovados e só colunas seguras (a view roda como dono, sem RLS).
create view public.public_dev_profiles as
  select user_id as id, slug, display_name, bio, portfolio_links
  from public.dev_profiles
  where status = 'approved';
revoke all on public.public_dev_profiles from public;
grant select on public.public_dev_profiles to anon, authenticated, service_role;

-- Curadoria: única porta de escrita do status para admin (aal2), sempre auditada.
create function public.admin_set_dev_status(p_dev uuid, p_status public.dev_status, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  current_status public.dev_status;
begin
  if not public.is_admin() then
    raise exception 'apenas admin com 2FA' using errcode = '42501';
  end if;
  select status into current_status from public.dev_profiles where user_id = p_dev for update;
  if not found then
    raise exception 'perfil de dev inexistente' using errcode = 'P0002';
  end if;
  if not (
    (current_status = 'pending' and p_status in ('approved', 'suspended'))
    or (current_status = 'approved' and p_status = 'suspended')
    or (current_status = 'suspended' and p_status = 'approved')
  ) then
    raise exception 'transição inválida: % para %', current_status, p_status using errcode = 'P0001';
  end if;
  update public.dev_profiles set status = p_status where user_id = p_dev;
  perform public.write_audit(auth.uid(), 'dev.status', 'dev_profiles', p_dev::text,
    jsonb_build_object('from', current_status, 'to', p_status, 'reason', p_reason));
end;
$$;
revoke all on function public.admin_set_dev_status(uuid, public.dev_status, text) from public, anon;
grant execute on function public.admin_set_dev_status(uuid, public.dev_status, text) to authenticated;
