-- Fase 1, catálogo: categorias, pacotes, níveis e curadoria de pacotes (ADR-013).
-- A trava "dev sem KYC não publica" mora no banco: toda mudança de status passa por funções
-- security definer; o dev não tem GRANT na coluna status.
create type public.package_status as enum ('draft', 'in_review', 'published', 'paused');
create type public.package_tier as enum ('basic', 'standard', 'premium');

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 60),
  name text not null check (char_length(name) between 2 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Categorias genéricas: o nicho do MVP ainda não foi decidido (ADR-009).
insert into public.categories (slug, name) values
  ('sites-e-landing-pages', 'Sites e landing pages'),
  ('lojas-virtuais', 'Lojas virtuais'),
  ('automacoes-e-integracoes', 'Automações e integrações'),
  ('aplicativos-e-sistemas', 'Aplicativos e sistemas'),
  ('manutencao-e-correcoes', 'Manutenção e correções'),
  ('consultoria-tecnica', 'Consultoria técnica');

create table public.packages (
  id uuid primary key,
  dev_id uuid not null references public.dev_profiles (user_id),
  category_id uuid not null references public.categories (id),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 80),
  title text not null check (char_length(title) between 5 and 80),
  summary text not null check (char_length(summary) between 10 and 160),
  description_md text not null default '' check (char_length(description_md) <= 10000),
  status public.package_status not null default 'draft',
  reject_reason text check (char_length(reject_reason) <= 500),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index packages_dev_idx on public.packages (dev_id);
create index packages_published_idx on public.packages (category_id) where status = 'published';
create trigger packages_touch before update on public.packages
  for each row execute function public.touch_updated_at();

create table public.package_tiers (
  package_id uuid not null references public.packages (id),
  tier public.package_tier not null,
  price_cents bigint not null check (price_cents > 0 and price_cents <= 10000000),
  delivery_days integer not null check (delivery_days between 1 and 30),
  revisions integer not null check (revisions between 0 and 10),
  scope_md text not null check (char_length(scope_md) between 10 and 5000),
  updated_at timestamptz not null default now(),
  primary key (package_id, tier)
);
create trigger package_tiers_touch before update on public.package_tiers
  for each row execute function public.touch_updated_at();

-- Histórico da curadoria: append-only, escrito só pelas funções abaixo.
create table public.package_curation_events (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.packages (id),
  actor_id uuid not null,
  from_status public.package_status not null,
  to_status public.package_status not null,
  reason text,
  created_at timestamptz not null default now()
);
create index package_curation_events_pkg_idx on public.package_curation_events (package_id, created_at);
create trigger package_curation_events_no_mutation
  before update or delete on public.package_curation_events
  for each row execute function public.forbid_mutation();
create trigger package_curation_events_no_truncate
  before truncate on public.package_curation_events
  for each statement execute function public.forbid_mutation();

alter table public.categories enable row level security;
alter table public.packages enable row level security;
alter table public.package_tiers enable row level security;
alter table public.package_curation_events enable row level security;

revoke all on public.categories, public.packages, public.package_tiers, public.package_curation_events
  from anon, authenticated;
grant select on public.categories to anon, authenticated;
grant select on public.packages, public.package_tiers, public.package_curation_events to authenticated;
grant insert (id, dev_id, category_id, slug, title, summary, description_md) on public.packages to authenticated;
grant update (category_id, title, summary, description_md) on public.packages to authenticated;
grant insert (package_id, tier, price_cents, delivery_days, revisions, scope_md) on public.package_tiers to authenticated;
grant update (price_cents, delivery_days, revisions, scope_md) on public.package_tiers to authenticated;
grant delete on public.package_tiers to authenticated;
grant all on public.categories, public.packages, public.package_tiers, public.package_curation_events to service_role;

create policy categories_select_active on public.categories
  for select to anon, authenticated using (active);

-- Dev suspenso não cria nem edita nada; o dono só mexe no que está em rascunho.
create function public.dev_is_active(p_dev uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.dev_profiles where user_id = p_dev and status <> 'suspended');
$$;
revoke all on function public.dev_is_active(uuid) from public, anon;
grant execute on function public.dev_is_active(uuid) to authenticated;

create policy packages_select_own on public.packages
  for select to authenticated using (dev_id = auth.uid());
create policy packages_select_admin on public.packages
  for select to authenticated using (public.is_admin());
create policy packages_insert_own on public.packages
  for insert to authenticated
  with check (dev_id = auth.uid() and public.dev_is_active(auth.uid()));
create policy packages_update_own_draft on public.packages
  for update to authenticated
  using (dev_id = auth.uid() and status = 'draft' and public.dev_is_active(auth.uid()))
  with check (dev_id = auth.uid());

create function public.package_is_own_draft(p_package uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.packages
    where id = p_package and dev_id = auth.uid() and status = 'draft' and public.dev_is_active(auth.uid())
  );
$$;
revoke all on function public.package_is_own_draft(uuid) from public, anon;
grant execute on function public.package_is_own_draft(uuid) to authenticated;

create policy tiers_select_own on public.package_tiers
  for select to authenticated
  using (exists (select 1 from public.packages p where p.id = package_id and p.dev_id = auth.uid()));
create policy tiers_select_admin on public.package_tiers
  for select to authenticated using (public.is_admin());
create policy tiers_insert_own_draft on public.package_tiers
  for insert to authenticated with check (public.package_is_own_draft(package_id));
create policy tiers_update_own_draft on public.package_tiers
  for update to authenticated
  using (public.package_is_own_draft(package_id)) with check (public.package_is_own_draft(package_id));
create policy tiers_delete_own_draft on public.package_tiers
  for delete to authenticated using (public.package_is_own_draft(package_id));

create policy curation_events_select_own on public.package_curation_events
  for select to authenticated
  using (exists (select 1 from public.packages p where p.id = package_id and p.dev_id = auth.uid()));
create policy curation_events_select_admin on public.package_curation_events
  for select to authenticated using (public.is_admin());

-- Trava de publicação. Os erros são códigos de máquina; a aplicação traduz para pt-BR.
create function public.catalog_assert_dev_can_sell(p_dev uuid, p_require_escrow boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  d public.dev_profiles;
begin
  select * into d from public.dev_profiles where user_id = p_dev;
  if not found or d.status <> 'approved' then
    raise exception 'dev_not_approved' using errcode = 'P0001';
  end if;
  if d.kyc_status <> 'approved' or d.provider_account_id is null then
    raise exception 'kyc_not_approved' using errcode = 'P0001';
  end if;
  if p_require_escrow and d.escrow_enabled_at is null then
    raise exception 'escrow_not_enabled' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.catalog_assert_dev_can_sell(uuid, boolean) from public, anon, authenticated;

-- "Até três níveis" (SPEC §3): o Básico é obrigatório; Padrão e Premium são opcionais.
create function public.catalog_assert_tiers_ok(p_package uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.package_tiers where package_id = p_package and tier = 'basic') then
    raise exception 'tiers_incomplete' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.catalog_assert_tiers_ok(uuid) from public, anon, authenticated;

create function public.catalog_move(
  p_package uuid, p_from public.package_status, p_to public.package_status, p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.packages
    set status = p_to,
        reject_reason = case when p_to = 'draft' then p_reason else null end,
        published_at = case when p_to = 'published' then coalesce(published_at, now()) else published_at end
    where id = p_package;
  insert into public.package_curation_events (package_id, actor_id, from_status, to_status, reason)
    values (p_package, auth.uid(), p_from, p_to, p_reason);
end;
$$;
revoke all on function public.catalog_move(uuid, public.package_status, public.package_status, text)
  from public, anon, authenticated;

-- Carrega o pacote do dono (ou do admin) travando a linha; "não existe" e "não é seu" dão o mesmo erro.
create function public.catalog_lock_package(p_package uuid, p_owner_only boolean) returns public.packages
language plpgsql security definer set search_path = public as $$
declare
  pkg public.packages;
begin
  select * into pkg from public.packages where id = p_package for update;
  if not found
     or (p_owner_only and pkg.dev_id <> auth.uid())
     or (not p_owner_only and not public.is_admin()) then
    raise exception 'package_not_found' using errcode = 'P0002';
  end if;
  return pkg;
end;
$$;
revoke all on function public.catalog_lock_package(uuid, boolean) from public, anon, authenticated;

create function public.catalog_submit_package(p_package uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  pkg public.packages := public.catalog_lock_package(p_package, true);
begin
  if pkg.status <> 'draft' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
  perform public.catalog_assert_dev_can_sell(pkg.dev_id, false);
  perform public.catalog_assert_tiers_ok(p_package);
  perform public.catalog_move(p_package, 'draft', 'in_review', null);
end;
$$;

-- Qualquer edição de conteúdo volta o pacote a rascunho (e sai da vitrine) até nova aprovação.
create function public.catalog_withdraw_package(p_package uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  pkg public.packages := public.catalog_lock_package(p_package, true);
begin
  if pkg.status = 'draft' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
  perform public.catalog_move(p_package, pkg.status, 'draft', null);
end;
$$;

create function public.catalog_pause_package(p_package uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  pkg public.packages := public.catalog_lock_package(p_package, true);
begin
  if pkg.status <> 'published' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
  perform public.catalog_move(p_package, 'published', 'paused', null);
end;
$$;

create function public.catalog_resume_package(p_package uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  pkg public.packages := public.catalog_lock_package(p_package, true);
begin
  if pkg.status <> 'paused' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
  perform public.catalog_assert_dev_can_sell(pkg.dev_id, true);
  perform public.catalog_move(p_package, 'paused', 'published', null);
end;
$$;

create function public.admin_approve_package(p_package uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  pkg public.packages;
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  pkg := public.catalog_lock_package(p_package, false);
  if pkg.status <> 'in_review' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
  perform public.catalog_assert_dev_can_sell(pkg.dev_id, true);
  perform public.catalog_assert_tiers_ok(p_package);
  perform public.catalog_move(p_package, 'in_review', 'published', null);
  perform public.write_audit(auth.uid(), 'package.approve', 'packages', p_package::text,
    jsonb_build_object('dev_id', pkg.dev_id));
end;
$$;

-- Recusa (in_review) ou retirada da vitrine (published, paused): volta a rascunho com motivo obrigatório.
create function public.admin_reject_package(p_package uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  pkg public.packages;
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;
  pkg := public.catalog_lock_package(p_package, false);
  if pkg.status = 'draft' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
  perform public.catalog_move(p_package, pkg.status, 'draft', left(btrim(p_reason), 500));
  perform public.write_audit(auth.uid(), 'package.reject', 'packages', p_package::text,
    jsonb_build_object('dev_id', pkg.dev_id, 'from', pkg.status, 'reason', left(btrim(p_reason), 500)));
end;
$$;

revoke all on function
  public.catalog_submit_package(uuid), public.catalog_withdraw_package(uuid),
  public.catalog_pause_package(uuid), public.catalog_resume_package(uuid),
  public.admin_approve_package(uuid), public.admin_reject_package(uuid, text)
  from public, anon;
grant execute on function
  public.catalog_submit_package(uuid), public.catalog_withdraw_package(uuid),
  public.catalog_pause_package(uuid), public.catalog_resume_package(uuid),
  public.admin_approve_package(uuid), public.admin_reject_package(uuid, text)
  to authenticated;

-- Vitrine pública: só pacote publicado de dev aprovado, com KYC aprovado e categoria ativa.
create view public.public_packages as
  select p.id, p.slug, p.title, p.summary, p.description_md, p.published_at,
         c.slug as category_slug, c.name as category_name,
         d.user_id as dev_id, d.slug as dev_slug, d.display_name as dev_name
  from public.packages p
  join public.categories c on c.id = p.category_id and c.active
  join public.dev_profiles d on d.user_id = p.dev_id and d.status = 'approved' and d.kyc_status = 'approved'
  where p.status = 'published';
create view public.public_package_tiers as
  select t.package_id, t.tier, t.price_cents, t.delivery_days, t.revisions, t.scope_md
  from public.package_tiers t
  join public.public_packages pp on pp.id = t.package_id;
revoke all on public.public_packages, public.public_package_tiers from public;
grant select on public.public_packages, public.public_package_tiers to anon, authenticated, service_role;
