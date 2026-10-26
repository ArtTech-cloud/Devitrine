# ADR-018: Persistência do ledger (migração 0016)

- Status: aceita
- Data: 2026-10-26

## Contexto

O ADR-004 fixou o ledger de dupla entrada; a SPEC §6 lista as contas e os lançamentos. A etapa 1 da Fase 2 precisa da persistência com as garantias no banco, não só na aplicação: só o módulo `ledger` escreve, todo `tx_id` fecha ou o lote inteiro é rejeitado, e as tabelas são append-only. Lembrete (ADR-002): a aplicação conecta como `postgres`, então o que de fato protege são os triggers, não os grants.

## Decisão

1. **Três tabelas** (migração `0016_ledger.sql`): `ledger_accounts` (código + dono, único por `(code, owner_id)`; as quatro contas da plataforma nascem na migração e as por dev nascem no primeiro lançamento), `ledger_transactions` (cabeçalho do lote: `tx_id`, `kind`, `idempotency_key` único, `order_id`, hash do conteúdo) e `ledger_entries` (linhas: `direction`, `amount_cents bigint > 0`, `currency = 'BRL'`, `seq` crescente).
2. **Única porta de escrita: `ledger_post(tx_id, kind, idempotency_key, order_id, lines jsonb)`.** Valida o lote inteiro antes de gravar (≥ 2 linhas, `amount_cents` como texto de inteiro positivo, débitos = créditos) e levanta `23514` se não fechar. O módulo `ledger` (`infra/ledger-repository.ts`) é o único código a chamá-la; a regra de ESLint proíbe importar `ledgerAccounts`, `ledgerTransactions` e `ledgerEntries` do schema fora de `src/modules/ledger`.
3. **Idempotência pela chave do evento de negócio** (por exemplo `payment_confirmed:<id do pagamento>`): mesma chave e mesmo conteúdo devolve `duplicate` sem gravar; mesma chave com tipo, pedido ou conteúdo diferentes levanta `23505` (`idempotency_conflict`). Concorrência: o `INSERT ... ON CONFLICT` serializa as chamadas; 10 postagens simultâneas geram um lote.
4. **Rede de segurança no banco:** gatilho deferido `ledger_entries_balanced` falha no COMMIT se um lote tocado não fecha ou tem menos de duas linhas, mesmo para quem inserir direto nas tabelas; gatilho `ledger_entries_same_xact` só deixa entrar linhas na transação que criou o cabeçalho (lote fechado nunca cresce).
5. **Append-only:** `forbid_mutation` em UPDATE, DELETE e TRUNCATE nas três tabelas (vale também para o dono do banco). `anon` e `authenticated` não têm nenhum acesso; `service_role` só tem `select` e `insert` e execução de `ledger_post` e `ledger_balance`. Extrato do dev e painel do admin entram na Fase 4 com policy própria. As três tabelas estão na lista do teste-guarda de grants (ADR-015).
6. **Saldo nunca é coluna:** `ledger_balance(code, owner)` e `getAllBalances` somam os lançamentos pelo lado normal da conta (devedoras: `gateway_cash`, `gateway_fees`, `dev_receivable`; credoras: as demais). Saldo disponível do dev = `dev_available` − `dev_receivable` (`getDevSpendableCents`).
7. **Valores** entram como texto de inteiro (`amount_cents` em string no JSON), nunca como número JSON, para não perder precisão nem aceitar decimal. `order_id` fica sem FK por enquanto: a tabela `orders` nasce depois, e a FK entra com ela.
8. **Builders de lançamento** (`domain/postings.ts`), um por linha da tabela da SPEC §6, omitem linhas de valor zero. Reembolso parcial: `D′ + P′ = G − R`, com P′ = taxa de `fee_bps` sobre `G − R` (SPEC: "P′ sobre G − R") e D′ = `G − R − P′`, para a soma fechar.
9. **Idempotência de chamadas ao gateway** continua em `idempotency_keys` (tabela do módulo `payments`, a criar com a cobrança); a chave do ledger é independente e protege o lançamento.

## Consequências

- O lançamento pode ser chamado na mesma transação de `transition()` (o `db` recebido é a transação do chamador).
- Corrigir um lançamento errado é um lançamento de estorno novo, nunca edição.
- A tabela `ledger_transactions` entra na SPEC §6.
- Os PRs do `ledger` exigem revisão humana antes do merge e revisão do Vigia.
- Decisão de negócio pendente (SPEC §14): quem arca com a taxa do chargeback; o lançamento atual supõe que a plataforma arca e cobra o dev depois.
