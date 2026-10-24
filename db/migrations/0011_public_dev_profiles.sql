-- Perfil publico do dev (ADR-014): a view da 0006 passa a exigir tambem KYC aprovado.
-- A pagina publica le esta view; status, KYC e dados do provedor nunca saem daqui.
-- Mesmas colunas da 0006, entao create or replace mantem os grants.
create or replace view public.public_dev_profiles as
  select d.user_id as id, d.slug, d.display_name, d.bio, d.portfolio_links
  from public.dev_profiles d
  where d.status = 'approved' and d.kyc_status = 'approved';
