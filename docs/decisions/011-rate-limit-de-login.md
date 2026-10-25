# ADR-011: Rate limit de login na aplicação, em Postgres

- Status: aceita
- Data: 2026-10-24

## Contexto

Hoje só valem os limites nativos do Supabase Auth; a aplicação não limita tentativas de login (pendência levantada pelo Vigia na Fase 0). A SPEC §10 pede rate limit por IP e por usuário em login. Não há Redis nem conta de borda disponíveis (ADR-008 e ADR-009).

## Decisão

- Contador em Postgres: tabela `rate_limits` e função `consume_rate_limit(key, limit, window)`, atômica por upsert, só service. A chave é o hash (SHA-256 com sal do servidor) de `IP:e-mail` e, separadamente, do IP.
- Limites iniciais: 5 tentativas por 15 minutos por IP e e-mail; 30 por 15 minutos por IP. Valem para `signInAction` e `signUpAction`, antes de chamar o Supabase Auth.
- Resposta genérica em pt-BR, sem revelar se o e-mail existe, e log estruturado de bloqueio para o alerta de falhas repetidas de login.
- O IP vem de `x-forwarded-for` só quando a hospedagem o sobrescreve (Vercel); sem isso, é um valor forjável. Isso é documentado como limitação e reavaliado quando houver infraestrutura de borda.
- Fora do escopo: TOTP do admin continua protegido só por senha até existir mais de um admin (ADR-006).

## Consequências

- Sem dependência externa nova; a migração entra na etapa 5 do plano da Fase 1.
- Trocar para Redis, Upstash ou WAF depois exige só substituir a implementação atrás de `rate-limit.ts`.

## Implementação (Fase 1, etapa 5)

- Migração 0012: `rate_limits (key, window_start, hits)` com RLS ligada e sem acesso para `anon`/`authenticated`; `consume_rate_limit(key, limit, window_seconds)` é `security definer`, só `service_role` executa. Janela fixa: o upsert zera o contador quando a janela expira; a contagem é atômica sob concorrência (testado com 20 chamadas paralelas). Chaves paradas há mais de um dia são apagadas de forma oportunista (1% das chamadas).
- Chave = HMAC-SHA256 de `ação\nIP[\ne-mail minúsculo]` com `SUPABASE_SERVICE_ROLE_KEY` como segredo, então o banco nunca guarda IP nem e-mail e não há variável de ambiente nova.
- `signInAction` e `signUpAction` contam a tentativa antes do Supabase Auth, com contadores separados por ação: 5 por IP e e-mail e 30 por IP, a cada 15 minutos. Tentativa bloqueada responde "Muitas tentativas. Aguarde alguns minutos e tente de novo." (a mesma para qualquer e-mail) e grava `warn` estruturado, sem e-mail.
- **Fail closed:** se o contador falhar (banco fora), a tentativa é negada e o erro vai para o log. Login depende do mesmo banco, então o custo é baixo.
- Login bem-sucedido também conta na janela; não há reset em caso de sucesso (MVP).
- No E2E, o Playwright manda um `x-forwarded-for` próprio por execução, para execuções seguidas não dividirem o contador de IP.

## Revisão do Vigia (Fase 1)

- O IP entra na chave via `ipRateLimitKey` (`src/lib/ip.ts`): IPv4 como veio, IPv4 mapeado em IPv6 vira IPv4, IPv6 vira o prefixo /64 (quem tem uma rede IPv6 controla 2^64 endereços; sem isso, trocar o final do endereço zerava os dois contadores). Valor que não é IP (header forjado, vazio) cai no balde único `unknown`. Limitação conhecida: sem proxy que defina o header (ambiente local ou outra hospedagem), todos compartilham o balde `unknown` (30 tentativas por 15 minutos para todo mundo); na Vercel isso não ocorre.
- Não existe limite por e-mail somando todos os IPs: um ataque distribuído contra uma conta só depende do limite próprio do Supabase Auth. Reavaliar com WAF ou Upstash na infraestrutura de borda.
