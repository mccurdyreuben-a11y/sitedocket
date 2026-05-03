-- Run this in Supabase SQL editor.
-- Enables UUID helpers.
create extension if not exists "pgcrypto";

-- App profiles table.
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null,
  company_name text,
  role text not null check (role in ('contractor', 'sub')),
  created_at timestamptz not null default now()
);

-- Sites created by contractor accounts.
create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  address text not null,
  start_date date,
  created_at timestamptz not null default now()
);

-- Dockets submitted by subcontractor accounts from the scan page.
create table if not exists public.dockets (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  subcontractor_id uuid not null references public.users(id) on delete restrict,
  submitted_by_auth_user_id uuid not null references auth.users(id) on delete restrict,
  trade_type text not null check (
    trade_type in ('Electrician', 'Plumber', 'Carpenter', 'Groundworker', 'Steelworker', 'Other')
  ),
  work_description text not null,
  hours_on_site numeric(5,2) not null check (hours_on_site >= 0),
  has_delay boolean not null default false,
  delay_category text check (
    delay_category in ('Weather', 'Access Denied', 'Materials Not Delivered', 'Design Issue', 'Other')
  ),
  delay_description text,
  delay_photo_url text,
  signature_data_url text not null,
  status text not null default 'submitted'
    check (status in ('submitted', 'approved', 'flagged')),
  flag_note text,
  reviewed_at timestamptz,
  reviewed_by uuid references public.users(id) on delete set null,
  work_date date not null default current_date,
  created_at timestamptz not null default now(),
  constraint delay_fields_consistent check (
    (has_delay = false and delay_category is null and delay_description is null)
    or (has_delay = true)
  )
);

create index if not exists idx_sites_contractor_id on public.sites(contractor_id);
create index if not exists idx_dockets_site_id on public.dockets(site_id);
create index if not exists idx_dockets_work_date on public.dockets(work_date);

alter table public.users enable row level security;
alter table public.sites enable row level security;
alter table public.dockets enable row level security;

-- Users can read/update only their own profile row.
drop policy if exists "users_select_self" on public.users;
create policy "users_select_self" on public.users
for select
to authenticated
using (auth.uid() = id);

drop policy if exists "users_upsert_self" on public.users;
create policy "users_upsert_self" on public.users
for all
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- Contractors manage their own sites; subcontractors can read to submit.
drop policy if exists "sites_select_any_auth" on public.sites;
create policy "sites_select_any_auth" on public.sites
for select
to authenticated
using (true);

drop policy if exists "sites_insert_contractor_owner" on public.sites;
create policy "sites_insert_contractor_owner" on public.sites
for insert
to authenticated
with check (
  contractor_id = auth.uid()
  and exists (
    select 1
    from public.users u
    where u.id = auth.uid() and u.role = 'contractor'
  )
);

drop policy if exists "sites_update_delete_contractor_owner" on public.sites;
create policy "sites_update_delete_contractor_owner" on public.sites
for all
to authenticated
using (
  contractor_id = auth.uid()
)
with check (
  contractor_id = auth.uid()
);

-- Docket submit/read permissions:
-- - subcontractor inserts only their own rows
-- - subcontractor reads own submissions
-- - contractors read dockets for their sites
drop policy if exists "dockets_insert_sub_own_row" on public.dockets;
create policy "dockets_insert_sub_own_row" on public.dockets
for insert
to authenticated
with check (
  subcontractor_id = auth.uid()
  and submitted_by_auth_user_id = auth.uid()
  and exists (
    select 1
    from public.users u
    where u.id = auth.uid() and u.role = 'sub'
  )
);

drop policy if exists "dockets_select_sub_own" on public.dockets;
create policy "dockets_select_sub_own" on public.dockets
for select
to authenticated
using (subcontractor_id = auth.uid());

drop policy if exists "dockets_select_contractor_by_site" on public.dockets;
create policy "dockets_select_contractor_by_site" on public.dockets
for select
to authenticated
using (
  exists (
    select 1
    from public.sites s
    where s.id = dockets.site_id and s.contractor_id = auth.uid()
  )
);

-- Storage bucket for delay photos.
insert into storage.buckets (id, name, public)
values ('docket-delays', 'docket-delays', true)
on conflict (id) do nothing;

drop policy if exists "delay_photos_read_public" on storage.objects;
create policy "delay_photos_read_public" on storage.objects
for select
to public
using (bucket_id = 'docket-delays');

drop policy if exists "delay_photos_upload_subs" on storage.objects;
create policy "delay_photos_upload_subs" on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'docket-delays'
  and (storage.foldername(name))[1] is not null
  and (storage.foldername(name))[2] = auth.uid()::text
);

-- ---------------------------------------------------------------------------
-- Approval flow: contractor reviews dockets for their own sites.
-- Re-runnable additive migrations for installs that pre-date these columns.
-- ---------------------------------------------------------------------------
alter table public.dockets
  add column if not exists flag_note text;
alter table public.dockets
  add column if not exists reviewed_at timestamptz;
alter table public.dockets
  add column if not exists reviewed_by uuid references public.users(id) on delete set null;

-- Drop the old default check (if any) and re-apply the constrained set.
alter table public.dockets
  drop constraint if exists dockets_status_check;
alter table public.dockets
  add constraint dockets_status_check
  check (status in ('submitted', 'approved', 'flagged'));

-- Contractors can update dockets that belong to their sites.
-- Subcontractors are still gated to read-only on their own rows
-- (handled by the existing select policy).
drop policy if exists "dockets_update_contractor_by_site" on public.dockets;
create policy "dockets_update_contractor_by_site" on public.dockets
for update
to authenticated
using (
  exists (
    select 1
    from public.sites s
    where s.id = dockets.site_id and s.contractor_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.sites s
    where s.id = dockets.site_id and s.contractor_id = auth.uid()
  )
);

-- Contractors need to read the submitting subcontractor's profile row
-- (name, company) to render the dockets list. Without this they only see
-- their own users row because of "users_select_self".
drop policy if exists "users_select_contractors_view_subs" on public.users;
create policy "users_select_contractors_view_subs" on public.users
for select
to authenticated
using (
  exists (
    select 1
    from public.dockets d
    join public.sites s on s.id = d.site_id
    where d.subcontractor_id = users.id
      and s.contractor_id = auth.uid()
  )
);
