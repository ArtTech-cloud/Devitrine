# ADR-013: Catálogo, pacotes com níveis e curadoria de pacotes

- Status: aceita
- Data: 2026-10-24

## Contexto

A Fase 1 pede categorias, pacotes com até três níveis, trava de publicação sem KYC e curadoria. A SPEC (§3, §6, §11) fixa os campos gerais, mas deixa em aberto limites, a regra de quantos níveis são obrigatórios e o que acontece quando um pacote publicado é editado. Sem nicho definido, as categorias são genéricas (ADR-009).

## Decisão

- Migração 0010: `categories` (6 categorias genéricas, `active`), `packages`, `package_tiers` (PK `package_id + tier`) e `package_curation_events` (append-only). IDs de pacote são UUID v7 gerados na aplicação.
- **Níveis:** o Básico é obrigatório; Padrão e Premium são opcionais ("até três níveis", §3). A regra vale na função SQL `catalog_assert_tiers_ok` e no formulário.
- **Limites (CHECK no banco e Zod):** título 5–80, resumo 10–160, descrição até 10.000, escopo 10–5.000 caracteres; preço de R$ 0,01 a R$ 100.000,00; prazo 1–30 dias; revisões 0–10. São limites de MVP, ajustáveis por migração nova.
- **Escrita do dev:** GRANT por coluna (insere `id, dev_id, category_id, slug, title, summary, description_md`; atualiza só conteúdo). `status`, `slug` e `published_at` só mudam pelas funções SQL. Níveis só são escritos no próprio rascunho (`package_is_own_draft`). Dev suspenso não cria nem edita.
- **Máquina de estados** (funções `security definer`, cada uma trava a linha e grava `package_curation_events`):
  `draft → in_review` (`catalog_submit_package`, dono), `in_review/published/paused → draft` (`catalog_withdraw_package`, dono), `published ⇄ paused` (dono), `in_review → published` (`admin_approve_package`), `in_review/published/paused → draft` com motivo (`admin_reject_package`, serve também para retirar da vitrine).
- **Trava de publicação** (`catalog_assert_dev_can_sell`): enviar para análise exige dev `approved` e KYC `approved` com subconta; aprovar e retomar exigem também `escrow_enabled_at`. Erros são códigos de máquina (`dev_not_approved`, `kyc_not_approved`, `escrow_not_enabled`, `tiers_incomplete`), traduzidos na aplicação.
- **Editar tira do ar:** editar pacote em análise, publicado ou pausado o devolve a rascunho na mesma transação e ele precisa de nova aprovação. Evita trocar o escopo depois da curadoria.
- **Aprovação do admin** exige `is_admin()` (aal2) e é auditada (`package.approve`, `package.reject`). Antes de aprovar, a aplicação tenta religar o escrow do dev pela API pública de `accounts` (`ensureDevEscrow`), cobrindo falha anterior do gateway.
- **Vitrine pública:** views `public_packages` e `public_package_tiers` (únicas leituras de anônimo): só pacote `published` de dev `approved` com KYC `approved` e categoria ativa. Suspender o dev esconde seus pacotes; reativar os devolve, sem mudar o status do pacote.
- Para o preço, a tela mostra a simulação do valor líquido com a setting `platform_fee_bps_first_order`.

## Consequências

- `package_tiers` não tem `id`: o pedido (Fase 2) referencia `(package_id, tier)` e guarda o `snapshot` do nível comprado; ajustar o nome `tier_id` da SPEC §6 quando a Fase 2 começar.
- O checkout (Fase 2) deve revalidar dev aprovado, KYC e escrow no momento da compra; a vitrine é só leitura.
- Retirar um pacote da vitrine é a mesma ação da recusa (motivo obrigatório), sem estado `removed` no MVP.
- Se o gateway real recusar a subconta depois de pacotes publicados, a vitrine some sozinha (a view depende de `kyc_status`).
