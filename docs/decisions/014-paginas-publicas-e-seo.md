# ADR-014: Páginas públicas e SEO

- Status: aceita
- Data: 2026-10-24

## Contexto

O portão da Fase 1 exige que o visitante veja a página do pacote publicado. A SPEC pede SSR para SEO do catálogo (§5) e Markdown sanitizado por allowlist (§10), mas não define rotas, metadados nem o que o perfil público do dev expõe.

## Decisão

- **Rotas públicas** (SSR dinâmico, sem login): `/pacotes` (vitrine, filtro `?categoria=`), `/pacotes/[slug]`, `/devs/[slug]`, `/sitemap.xml` e `/robots.txt`. Slug inexistente, malformado ou de pacote não público responde 404 (sem distinguir "não existe" de "não publicado").
- **Leitura só pelas views.** Pacotes vêm de `public_packages` e `public_package_tiers` (ADR-013). Migração 0011 troca a view `public_dev_profiles` (0006) para exigir também `kyc_status = 'approved'`, as mesmas colunas de antes (`id, slug, display_name, bio, portfolio_links`), então os grants se mantêm. Status, KYC e dados do provedor nunca saem. As queries rodam com `withService` sobre essas views; o `index.ts` de cada módulo exporta só as funções públicas.
- **SEO por página:** `title`, `description` (resumo), `canonical`, Open Graph; 404 com `noindex`. O pacote traz JSON-LD `Service` com `AggregateOffer` (BRL, preço mínimo, máximo e uma `Offer` por nível); o dev traz `Person`. O JSON-LD escapa `<`, `>` e `&` para o texto do dev não fechar a tag. Preço em centavos inteiros, formatado sem ponto flutuante.
- **URL do site** vem de `NEXT_PUBLIC_SITE_URL` (sem valor em `.env.example`); sem ela, usa `http://127.0.0.1:3000`. Em produção, defina-a.
- **Sitemap** lista home, vitrine, pacotes publicados e devs visíveis. `robots.txt` bloqueia `/app`, `/admin`, `/api`, `/login` e `/signup`.
- **Markdown do dev sanitizado (SPEC §10).** `descriptionMd` e `scopeMd` passam por `renderMarkdown` (`src/lib/markdown.ts`, só servidor): `markdown-it` com `html: false` (HTML bruto vira texto escapado) e, sobre o HTML gerado, `sanitize-html` com allowlist como segunda barreira. Tags permitidas: `p, br, strong, em, ul, ol, li, a, code, pre, blockquote` e títulos; atributos só `href` (com `rel="noopener noreferrer nofollow ugc"` e `target="_blank"` forçados); esquemas só `http`, `https` e `mailto`; sem imagens, tabelas, `style` nem eventos. Títulos h1-h2 viram h3, h3 vira h4 e o resto h5, para não competir com o h1/h2 da página. Escolhi `markdown-it` + `sanitize-html` por serem allowlist, maduros e sem pipeline de plugins; `remark/rehype` exigiria mais peças para o mesmo resultado. A bio do dev continua texto puro (não é Markdown na SPEC). Links do portfólio saem com `rel="noopener noreferrer nofollow ugc"`.
- **E2E do portão:** o gateway fake não roda em `next start`, então o teste semeia no banco o dev aprovado, o KYC e o escrow; o resto (rascunho, envio, aprovação do admin com TOTP, visitante) usa a interface real.
- **Views públicas somente leitura (migração 0013_public_views_readonly).** Os default privileges do Supabase davam INSERT/UPDATE/DELETE/TRUNCATE a `anon` e `authenticated` nas views, e `public_dev_profiles` (view simples, auto-atualizável, sem `security_invoker`) permitia a anon reescrever `dev_profiles` ignorando RLS e grants por coluna (achado do Vigia). A migração faz `revoke all` e concede só `select` nas três views. Teste de integração confere `has_table_privilege` e que UPDATE/INSERT/DELETE falham com `permission denied`.
- **`portfolio_links` validado no banco:** CHECK `portfolio_links_ok` exige array de strings que começam com `http://` ou `https://` (dados antigos inválidos são removidos na migração). A página `/devs/[slug]` também só renderiza e põe em JSON-LD `sameAs` links http(s).
- **`public_packages` não expõe mais `dev_id`** (UUID de `auth.users`): a página do dev filtra por `dev_slug`.

## Consequências

- Dev aprovado sem KYC aprovado deixa de aparecer em `/devs/[slug]` (antes aparecia na view da 0006); o teste de RLS da etapa 1 foi ajustado.
- Páginas dinâmicas consultam o banco a cada requisição; cache/ISR fica para quando houver volume.
- Sem imagem Open Graph no MVP (não há upload de capa de pacote na SPEC).

## Pendências abertas (fechamento do portão da Fase 1)

- 500 intermitente em `/pacotes/<inexistente>`, visto uma vez e não reproduzido. Se voltar, abrir teste E2E de regressão.
- Baixas da revisão de QA, não bloqueantes: sem proxy que defina o IP, todos caem no balde `unknown` do rate limit (na Vercel não ocorre); sem limite por e-mail somando todos os IPs; `dev_is_active` serve de oráculo de UUID; páginas públicas sem cache; sem teto de pacotes por dev; links relativos aceitos no Markdown.
- `pnpm db:check` só roda com `origin/main`; rodar no primeiro push e tratar falha como bloqueio de merge.
