# ADR-006: Papel fica em public.users e admin só existe por convite com TOTP

- Status: aceita
- Data: 2026-10-24

## Contexto

O papel (client, dev, admin) precisa ser lido pelo RLS e pela aplicação sem confiar em dado que o próprio usuário edita. O `user_metadata` do Supabase Auth é editável pelo usuário; o `app_metadata` só pela service key.

## Decisão

- O papel mora em `public.users.role`, criado por trigger em `auth.users`. O cadastro público aceita `signup_role` só com `client` ou `dev`; qualquer outro valor vira `client`.
- Admin só nasce por convite: a service key grava `app_metadata.role = 'admin'`. Como o GoTrue grava o `app_metadata` depois do insert, um segundo trigger (migração 0004) sincroniza o papel no UPDATE, inclusive para rebaixar.
- `is_admin()` exige papel admin e JWT com `aal = 'aal2'`, ou seja, TOTP verificado. Admin sem segundo fator é mandado para `/admin/mfa` e não lê nada com privilégio de admin.
- Alterar configurações passa por `admin_set_setting`, que confere `is_admin()` e grava `audit_log`.

## Consequências

- Nenhum caminho de cadastro público produz admin.
- Perder o TOTP exige intervenção com service key; é intencional.
- Os testes de RLS cobrem os três papéis e o admin com e sem `aal2`.

## Limitação conhecida

O primeiro cadastro de TOTP do admin (enrolamento) é protegido só pela senha: quem tem a senha do convite consegue registrar o próprio fator. Mitigação: o convite é enviado pelo dono por canal controlado e a senha inicial é trocada no primeiro acesso. Reforçar (link de enrolamento de uso único ou aprovação de outro admin) antes de abrir admins além do dono; registrar nova decisão quando isso entrar.
