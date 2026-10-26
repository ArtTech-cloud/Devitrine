# ADR-012: Onboarding do dev, KYC pela porta RecipientGateway e curadoria

- Status: aceita
- Data: 2026-10-24

## Contexto

A Fase 1 pede perfil do dev, subconta e KYC no gateway, escrow só para dev aprovado (SPEC §8: mensalidade por subconta) e curadoria. A porta `RecipientGateway` e o fake estão definidos nos ADR-009 e ADR-010; falta fixar o fluxo de uso.

## Decisão

- O slug nasce do nome (`slugify`) e não muda nas edições; colisão (23505) tenta até 5 vezes com sufixo aleatório.
- O dev só escreve nome, bio e links (GRANT por coluna, ADR de 0006). Status, KYC e campos do provedor são escritos pelo servidor (`withService`) depois de checar o ator; o `INSERT` do dev lista só as colunas com GRANT.
- Início do KYC é reservado atomicamente (`kyc_status` `not_started` → `pending` num `UPDATE ... WHERE`), então duas requisições criam uma só subconta. Reserva abandonada (pendente, sem subconta, parada há mais de 2 min) pode ser retomada. A criação usa a chave de idempotência `kyc:{devId}:{tentativa}`; falha do gateway devolve a reserva.
- Consulta de KYC: no máximo uma por 30 s por dev (coluna `kyc_checked_at`, migração 0008), reservada por `UPDATE` condicional. A criação da subconta não conta no intervalo.
- Escrow (`enableEscrow`, chave `escrow:{devId}`, `daysToExpire` da setting `escrow_days_to_expire`, `isFeePayer = false`) liga uma única vez quando dev `approved` e KYC `approved`, tanto ao aprovar na curadoria quanto ao consultar o KYC. Falha ao ligar depois da aprovação não desfaz a aprovação; a próxima consulta tenta de novo.
- Curadoria: só `admin_set_dev_status` (admin com aal2, transições válidas, auditoria). A UI lista a fila em `/admin/curadoria`.
- Mensagens de erro ao dev não expõem detalhe do gateway; o detalhe vai para o log (que mascara dados sensíveis).

## Consequências

- `isFeePayer = false` (plataforma arca com a taxa do escrow) é suposição para a Fase 1 com o fake. Antes de qualquer ambiente de produção, confirmar com o Asaas real e com os números do negócio; não bloqueia o desenvolvimento. Consolidado como pendência de negócio no ADR-019.
- Sem conta de sandbox, tudo roda no fake; o adaptador Asaas (Cofre) entra por `src/lib/composition.ts` sem mudar o módulo.
- KYC `rejected` permite reenvio sem admin (decisão de Arthur): o dev edita os dados e reinicia; `kyc_status` volta a `not_started`, a subconta recusada e o `escrow_enabled_at` são soltos (o id antigo vai para o log) e `kyc_attempts` (migração 0009) sobe, entrando na chave de idempotência `kyc:{devId}:{tentativa}`. Não há fluxo de apelação. A subconta recusada pode ficar órfã no gateway; limpar é tarefa do adaptador Asaas (Cofre).
