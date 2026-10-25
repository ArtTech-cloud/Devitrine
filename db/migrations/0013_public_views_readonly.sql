-- Views publicas somente leitura (ADR-014). A 0011/0010 so concediam SELECT, mas os default
-- privileges do Supabase tambem davam INSERT/UPDATE/DELETE/TRUNCATE a anon e authenticated, e a
-- view simples public_dev_profiles e auto-atualizavel e roda como dono (ignora RLS e GRANT por coluna).
-- public_packages deixa de expor dev_id (UUID de auth.users): a vitrine usa dev_slug.
drop view public.public_package_tiers;
drop view public.public_packages;

create view public.public_packages as
  select p.id, p.slug, p.title, p.summary, p.description_md, p.published_at,
         c.slug as category_slug, c.name as category_name,
         d.slug as dev_slug, d.display_name as dev_name
  from public.packages p
  join public.categories c on c.id = p.category_id and c.active
  join public.dev_profiles d on d.user_id = p.dev_id and d.status = 'approved' and d.kyc_status = 'approved'
  where p.status = 'published';
create view public.public_package_tiers as
  select t.package_id, t.tier, t.price_cents, t.delivery_days, t.revisions, t.scope_md
  from public.package_tiers t
  join public.public_packages pp on pp.id = t.package_id;

revoke all on public.public_dev_profiles, public.public_packages, public.public_package_tiers
  from public, anon, authenticated, service_role;
grant select on public.public_dev_profiles, public.public_packages, public.public_package_tiers
  to anon, authenticated, service_role;

-- Defesa em profundidade: cada link do portfolio precisa ser http(s). Dados antigos invalidos sao removidos.
create function public.portfolio_links_ok(l jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(l) = 'array' and not exists (
    select 1 from jsonb_array_elements(l) e
    where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* '^https?://'
  )
$$;

update public.dev_profiles d
set portfolio_links = coalesce((
  select jsonb_agg(e) from jsonb_array_elements(d.portfolio_links) e
  where jsonb_typeof(e) = 'string' and (e #>> '{}') ~* '^https?://'
), '[]'::jsonb)
where not public.portfolio_links_ok(d.portfolio_links);

alter table public.dev_profiles
  add constraint dev_profiles_portfolio_links_http check (public.portfolio_links_ok(portfolio_links));

-- Default privileges (0013_close_default_privileges) tiram EXECUTE de PUBLIC; o CHECK roda com o papel do chamador.
revoke all on function public.portfolio_links_ok(jsonb) from public;
grant execute on function public.portfolio_links_ok(jsonb) to anon, authenticated, service_role;
