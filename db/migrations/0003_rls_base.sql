-- Admin só vale com segundo fator (aal2) no JWT.
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.role = 'admin'
      and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
  );
$$;
grant execute on function public.is_admin() to authenticated;

alter table public.users enable row level security;
alter table public.settings enable row level security;
alter table public.audit_log enable row level security;

-- Privilégios mínimos: nada de escrita direta por usuários.
revoke all on public.users, public.settings, public.audit_log from anon, authenticated;
grant select on public.users to authenticated;
grant select on public.settings to authenticated;
grant select on public.audit_log to authenticated;
grant all on public.users, public.settings to service_role;
grant select, insert on public.audit_log to service_role;

create policy users_select_own on public.users
  for select to authenticated using (id = auth.uid());
create policy users_select_admin on public.users
  for select to authenticated using (public.is_admin());

create policy settings_select_authenticated on public.settings
  for select to authenticated using (true);

create policy audit_log_select_admin on public.audit_log
  for select to authenticated using (public.is_admin());

-- Escrita de settings só por função auditada.
create function public.admin_set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  old_value jsonb;
begin
  if not public.is_admin() then
    raise exception 'apenas admin com 2FA' using errcode = '42501';
  end if;
  select value into old_value from public.settings where key = p_key;
  if not found then
    raise exception 'setting desconhecida: %', p_key using errcode = 'P0002';
  end if;
  update public.settings set value = p_value, updated_at = now(), updated_by = auth.uid()
    where key = p_key;
  perform public.write_audit(auth.uid(), 'settings.update', 'settings', p_key,
    jsonb_build_object('old', old_value, 'new', p_value));
end;
$$;
revoke all on function public.admin_set_setting(text, jsonb) from public, anon;
grant execute on function public.admin_set_setting(text, jsonb) to authenticated;
