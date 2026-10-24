create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  ip inet,
  diff jsonb,
  created_at timestamptz not null default now()
);

create function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% é append-only: % bloqueado', tg_table_name, tg_op using errcode = 'P0001';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function public.forbid_mutation();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.forbid_mutation();

-- Única porta de escrita no audit_log para quem não é service role.
create function public.write_audit(
  p_actor uuid, p_action text, p_entity text, p_entity_id text, p_diff jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_log (actor_id, action, entity, entity_id, diff)
  values (p_actor, p_action, p_entity, p_entity_id, p_diff);
$$;
revoke all on function public.write_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;
