-- Limite de frequência da consulta de KYC (ADR-012): escrito só pelo servidor (service role).
alter table public.dev_profiles add column kyc_checked_at timestamptz;
