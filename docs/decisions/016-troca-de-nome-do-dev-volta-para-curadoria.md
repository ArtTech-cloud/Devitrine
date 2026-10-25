# ADR-016: Troca de nome do dev aprovado volta para a curadoria

- Status: aceita
- Data: 2026-10-25

## Contexto

Um dev aprovado podia editar `display_name`, bio e links sem nova análise (GRANT por coluna, migração 0006). O nome aparece em pacotes, listagens, metadados e JSON-LD; trocá-lo depois da aprovação permite se passar por outra marca. A SPEC não tratava a edição de perfil depois da aprovação. Arthur decidiu seguir a recomendação da revisão de segurança.

## Decisão

- Trocar o `display_name` de um dev `approved` o devolve a `pending` e ele sai da vitrine (os pacotes dele somem junto, pois a vitrine exige dev aprovado) até o admin aprovar de novo.
- Bio e links seguem livres: bio é texto puro, links só `http(s)` (CHECK no banco) e saem com `nofollow ugc`.
- A regra mora no banco: gatilho `BEFORE UPDATE` em `dev_profiles` (migração 0015), `security definer`, sem EXECUTE para os papéis de API. Só age quando o status não está sendo alterado no mesmo `UPDATE`, então `admin_set_dev_status` passa intacta. Regravar o mesmo nome não muda nada. Cada devolução grava `dev.rename_review` em `audit_log` com o nome antigo e o novo.
- A aplicação avisa o dev na hora de salvar (`sentToReview`).
- Dev `pending` que troca o nome continua `pending`; dev `suspended` continua sem editar.

## Consequências

- O escrow e o KYC já ligados não mudam; o status volta a `approved` pela curadoria normal.
- Pacotes publicados continuam `published` no catálogo e reaparecem quando o dev é reaprovado.
- O slug não muda com o nome (ADR-012), então links antigos para `/devs/[slug]` voltam a funcionar na reaprovação.
