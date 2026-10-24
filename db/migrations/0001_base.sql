-- Fase 0: papéis, usuários e configurações.
create extension if not exists pgcrypto;

create type public.user_role as enum ('client', 'dev', 'admin');

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  role public.user_role not null default 'client',
  mfa_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- O papel nunca vem de user_metadata (o usuário edita). Cadastro público só
-- escolhe client ou dev; admin só por convite, via app_metadata (service key).
create function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  chosen public.user_role := 'client';
  requested text := new.raw_user_meta_data ->> 'signup_role';
begin
  if new.raw_app_meta_data ->> 'role' = 'admin' then
    chosen := 'admin';
  elsif requested = 'dev' then
    chosen := 'dev';
  end if;
  insert into public.users (id, email, role) values (new.id, coalesce(new.email, ''), chosen);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id)
);

insert into public.settings (key, value) values
  ('platform_fee_bps_first_order', '1500'),
  ('platform_fee_bps_repeat', '1000'),
  ('platform_fee_bps_high_volume', '500'),
  ('high_volume_threshold_cents', '1500000'),
  ('awaiting_payment_hours', '24'),
  ('dev_accept_hours', '24'),
  ('approval_window_hours', '72'),
  ('delay_tolerance_hours', '48'),
  ('escrow_days_to_expire', '60'),
  ('withdrawals_paused', 'false');
