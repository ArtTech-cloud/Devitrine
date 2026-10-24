# ADR-002: RLS como segunda barreira de autorização

- Status: aceita
- Data: 2026-10-24

## Contexto

A autorização é checada em cada caso de uso, mas um filtro esquecido ali vazaria pedidos, chats ou entregas de outra pessoa.

## Decisão

Row Level Security ligada em toda tabela com dado de usuário. Consultas feitas em nome de um usuário rodam com o papel `authenticated` e as claims do JWT dele; só o servidor e os jobs usam a service key, e o acesso de admin passa por funções auditadas.

## Consequências

- Um bug de autorização na aplicação, sozinho, não vaza dados.
- Com Drizzle, cada transação feita em nome de um usuário define o papel e as claims (`set local role authenticated` e `request.jwt.claims`) antes das consultas; uma conexão sem isso ignora a RLS.
- Toda tabela nova precisa de políticas e de teste de integração com RLS ligada.
