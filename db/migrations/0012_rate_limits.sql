-- Rate limit em Postgres (ADR-011): contador de janela fixa, atomico por upsert, so service_role.
create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits integer not null
);

alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from public, anon, authenticated;

-- Conta uma tentativa e diz se ainda cabe no limite. Janela expirada recomeca em 1.
create function public.consume_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits integer;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid_rate_limit';
  end if;
  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when r.window_start <= now() - make_interval(secs => p_window_seconds)
                then 1 else r.hits + 1 end,
    window_start = case when r.window_start <= now() - make_interval(secs => p_window_seconds)
                        then now() else r.window_start end
  returning hits into v_hits;
  -- Faxina oportunista de chaves paradas ha mais de um dia.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_limit;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
