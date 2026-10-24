-- O GoTrue insere o usuário e só depois grava o app_metadata (convite de admin),
-- então o papel também precisa ser sincronizado no UPDATE de auth.users.
-- Promoção para admin vem só de app_metadata (service key); remover o papel rebaixa para client.
create function public.handle_auth_user_updated() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.raw_app_meta_data ->> 'role' = 'admin' then
    update public.users set role = 'admin', updated_at = now()
      where id = new.id and role <> 'admin';
  elsif old.raw_app_meta_data ->> 'role' = 'admin' then
    update public.users set role = 'client', updated_at = now()
      where id = new.id and role = 'admin';
  end if;
  return new;
end;
$$;

create trigger on_auth_user_updated
  after update of raw_app_meta_data on auth.users
  for each row
  when (old.raw_app_meta_data is distinct from new.raw_app_meta_data)
  execute function public.handle_auth_user_updated();

-- Corrige admins que já foram criados antes deste gatilho.
update public.users u set role = 'admin'
  from auth.users a
  where a.id = u.id and a.raw_app_meta_data ->> 'role' = 'admin' and u.role <> 'admin';
