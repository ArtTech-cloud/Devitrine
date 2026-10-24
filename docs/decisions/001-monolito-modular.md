# ADR-001: Monólito modular

- Status: aceita
- Data: 2026-10-24

## Contexto

Time pequeno, um produto e um deploy. Microsserviços trariam rede, filas e versões independentes sem ganho nesta fase.

## Decisão

Um app Next.js em TypeScript, com os domínios em `src/modules/<nome>`. Cada módulo tem `domain/`, `application/` e `infra/` e expõe uma API pública em `index.ts`. Um módulo não lê tabelas de outro.

## Consequências

- Um deploy, uma base de código e transações locais entre módulos.
- As fronteiras dependem de disciplina: revisão de PR e uma regra de lint que proíbe importar o interior de outro módulo.
- Extrair um módulo depois continua possível, porque ele já tem API própria.
