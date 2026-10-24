# ADR-009: Pendências externas da Fase 1 (sandbox do Asaas) e marca provisória

- Status: aceita
- Data: 2026-10-24

## Contexto

O dono decidiu manter o projeto só local: sem conta no Asaas (sandbox), GitHub, Vercel, Supabase cloud ou Sentry. A Fase 1 exige "subconta e KYC no sandbox do Asaas" (SPEC §4), o que não é possível sem uma conta e uma chave de sandbox. Nicho e nome da marca (SPEC §14) também não foram decididos.

## Decisão

1. **KYC com adaptador fake.** O onboarding do dev usa a porta `RecipientGateway` (ADR-010) com um adaptador fake em memória/banco, só para desenvolvimento e testes. O fake nunca é ligado em produção: a composição falha na inicialização se `NODE_ENV=production` e o adaptador for o fake.
2. **Pendências externas** (somam-se às do ADR-008), a resolver quando o dono liberar as contas:
   - Conta e chave de API do sandbox do Asaas.
   - Adaptador Asaas real de subconta/KYC/escrow (do Cofre, em `payments`) validado contra o sandbox: campos obrigatórios, fonte do link de KYC, limite de `daysToExpire`.
   - Teste de contrato noturno da SPEC §12 para esse adaptador.
3. **Portão da Fase 1:** "dev aprovado publica pacote, visitante vê a página, dev sem KYC não publica" passa com o fake. O fechamento por inteiro do critério "KYC no sandbox do Asaas" fica pendente da conta, no mesmo molde do ADR-008.
4. **Marca e nicho:** categorias genéricas de seed (editáveis pelo admin) e o nome provisório "Marketplace de Serviços Digitais", centralizado numa constante, sem identidade visual definitiva. Trocar é uma alteração de configuração.

## Consequências

- A Fase 2 não depende do sandbox para começar a modelar, mas o teste de contrato do Asaas só roda depois da conta.
- Nenhuma credencial externa é pedida ou criada por este ADR.
