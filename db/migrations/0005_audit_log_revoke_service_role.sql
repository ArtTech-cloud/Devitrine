-- Defesa em profundidade: o trigger já bloqueia, e agora o privilégio também some.
revoke update, delete, truncate on public.audit_log from service_role;
