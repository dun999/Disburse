alter table public.payment_requests
  add column if not exists mode text not null default 'arc' check (mode in ('arc', 'arc_settlement')),
  add column if not exists destination_chain_id integer,
  add column if not exists allowed_source_chain_ids integer[],
  add column if not exists source_chain_id integer,
  add column if not exists settlement_stage text check (settlement_stage in ('submitted', 'proving', 'settling', 'settled', 'failed')),
  add column if not exists source_tx_hash text check (source_tx_hash is null or source_tx_hash ~* '^0x[0-9a-f]{64}$'),
  add column if not exists source_block_number text,
  add column if not exists source_log_index integer,
  add column if not exists proof_job_id text,
  add column if not exists destination_tx_hash text check (destination_tx_hash is null or destination_tx_hash ~* '^0x[0-9a-f]{64}$'),
  add column if not exists destination_block_number text;

alter table public.payment_receipts
  add column if not exists chain_id integer,
  add column if not exists source_chain_id integer,
  add column if not exists source_tx_hash text check (source_tx_hash is null or source_tx_hash ~* '^0x[0-9a-f]{64}$');

alter table public.payment_request_events
  add column if not exists settlement jsonb;

alter table public.payment_request_events
  drop constraint if exists payment_request_events_event_type_check;

alter table public.payment_request_events
  add constraint payment_request_events_event_type_check
  check (event_type in ('submitted', 'proving', 'settling', 'paid', 'failed', 'expired'));

alter table public.payment_requests
  drop constraint if exists payment_requests_mode_check;

alter table public.payment_requests
  add constraint payment_requests_mode_check
  check (mode in ('arc', 'arc_settlement'));

create index if not exists payment_requests_mode_idx on public.payment_requests(mode);
create index if not exists payment_requests_source_tx_hash_idx on public.payment_requests(source_tx_hash);
create index if not exists payment_requests_destination_tx_hash_idx on public.payment_requests(destination_tx_hash);
