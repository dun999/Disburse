create table if not exists public.payment_requests (
  id uuid primary key,
  recipient text not null check (recipient ~* '^0x[0-9a-f]{40}$'),
  token text not null check (token in ('USDC', 'EURC')),
  amount text not null,
  label text not null,
  note text,
  invoice_date date,
  expires_at timestamptz,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  start_block text not null,
  status text not null default 'open' check (status in ('open', 'paid', 'possible_match', 'expired', 'failed')),
  tx_hash text check (tx_hash is null or tx_hash ~* '^0x[0-9a-f]{64}$'),
  failure_reason text,
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_receipts (
  request_id uuid primary key references public.payment_requests(id) on delete cascade,
  tx_hash text not null unique check (tx_hash ~* '^0x[0-9a-f]{64}$'),
  payer text not null check (payer ~* '^0x[0-9a-f]{40}$'),
  recipient text not null check (recipient ~* '^0x[0-9a-f]{40}$'),
  token text not null check (token in ('USDC', 'EURC')),
  amount text not null,
  block_number text not null,
  confirmed_at timestamptz not null,
  explorer_url text not null
);

create table if not exists public.payment_request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.payment_requests(id) on delete cascade,
  event_type text not null check (event_type in ('submitted', 'paid', 'failed', 'expired')),
  status text not null check (status in ('open', 'paid', 'possible_match', 'expired', 'failed')),
  message text not null,
  tx_hash text check (tx_hash is null or tx_hash ~* '^0x[0-9a-f]{64}$'),
  submitted_at timestamptz,
  receipt jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payment_requests_status_idx on public.payment_requests(status);
create index if not exists payment_request_events_request_id_idx on public.payment_request_events(request_id, id desc);

alter table public.payment_requests enable row level security;
alter table public.payment_receipts enable row level security;
alter table public.payment_request_events enable row level security;

drop policy if exists "payment_request_events_are_publicly_readable" on public.payment_request_events;
create policy "payment_request_events_are_publicly_readable"
  on public.payment_request_events
  for select
  to anon
  using (true);

grant usage on schema public to anon;
grant select on public.payment_request_events to anon;

alter table public.payment_request_events replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'payment_request_events'
  ) then
    alter publication supabase_realtime add table public.payment_request_events;
  end if;
end
$$;
