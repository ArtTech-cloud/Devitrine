-- ADR-016: dev aprovado que troca o nome de exibição volta para `pending` até nova curadoria
-- (evita se passar por outra marca depois de aprovado). Bio e links continuam livres.
-- Só dispara quando o UPDATE não mexe no status: as transições do admin passam intactas.
create function public.dev_name_change_requires_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'approved'
     and new.status = old.status
     and new.display_name is distinct from old.display_name then
    new.status := 'pending';
    perform public.write_audit(auth.uid(), 'dev.rename_review', 'dev_profiles', old.user_id::text,
      jsonb_build_object('from_name', old.display_name, 'to_name', new.display_name));
  end if;
  return new;
end;
$$;
revoke all on function public.dev_name_change_requires_review() from public, anon, authenticated;

create trigger dev_profiles_name_review
  before update on public.dev_profiles
  for each row execute function public.dev_name_change_requires_review();
