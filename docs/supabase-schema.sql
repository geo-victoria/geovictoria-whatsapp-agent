-- GeoVictoria WhatsApp Agent persistence schema
-- Run this in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.vic_conversations (
  id uuid primary key default gen_random_uuid(),
  contact text not null unique,
  started_at timestamptz not null,
  updated_at timestamptz not null,
  last_user_at timestamptz null,
  lead jsonb null,
  last_evaluation_at timestamptz null,
  last_evaluation jsonb null,
  created_at timestamptz not null default now()
);

create table if not exists public.vic_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.vic_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  at timestamptz not null
);

create table if not exists public.vic_leads (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.vic_conversations(id) on delete cascade,
  contact text not null,
  lead jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.vic_evaluations (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.vic_conversations(id) on delete cascade,
  contact text not null,
  evaluation jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_vic_conversations_updated_at on public.vic_conversations(updated_at desc);
create index if not exists idx_vic_messages_conversation_at on public.vic_messages(conversation_id, at);
create index if not exists idx_vic_leads_created_at on public.vic_leads(created_at desc);
create index if not exists idx_vic_evaluations_created_at on public.vic_evaluations(created_at desc);
