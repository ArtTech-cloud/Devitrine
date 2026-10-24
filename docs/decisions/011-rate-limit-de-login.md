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
