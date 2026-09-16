-- Fahrzeug-Lebenslauf
-- Fahrzeuge gehören zu einem Workspace. Dokumente werden NICHT per Spalte verknüpft,
-- sondern über den Tag: Ein Dokument mit Tag "Bulli" gehört zum Fahrzeug "Bulli".
-- Wartungen und Serviceintervalle werden manuell gepflegt.
-- Benötigt public.my_workspace_ids() aus 20260916120000_workspace_sicherheit.sql

-- ===== Fahrzeuge =====
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null check (length(trim(name)) > 0),
  details text,                                   -- z.B. "VW T5 · OL-AB 123"
  current_km integer check (current_km >= 0),     -- zuletzt manuell eingetragener km-Stand
  current_km_date date,
  created_at timestamptz not null default now()
);
-- Name pro Workspace eindeutig (Groß/Klein egal), weil er als Tag dient
create unique index vehicles_workspace_name_key on public.vehicles (workspace_id, lower(trim(name)));

-- ===== Wartungen (ein Eintrag = ein Werkstattbesuch, ggf. mehrere Arbeiten) =====
create table public.vehicle_services (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  work_items text[] not null check (cardinality(work_items) > 0),   -- z.B. {Ölwechsel,Ölfilter}
  service_date date not null,
  km integer check (km >= 0),
  cost numeric(10,2) check (cost >= 0),
  workshop text,
  notes text,
  document_id uuid references public.documents(id) on delete set null,  -- optionaler Beleg
  added_by uuid references auth.users(id) default auth.uid(),
  added_by_name text,
  created_at timestamptz not null default now()
);
create index vehicle_services_vehicle_date_idx on public.vehicle_services (vehicle_id, service_date desc);
create index vehicle_services_document_idx on public.vehicle_services (document_id);

-- ===== Serviceintervalle =====
create table public.vehicle_intervals (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  service_type text not null check (length(trim(service_type)) > 0),
  interval_months integer check (interval_months > 0),
  interval_km integer check (interval_km > 0),
  created_at timestamptz not null default now(),
  check (interval_months is not null or interval_km is not null)
);
create unique index vehicle_intervals_type_key on public.vehicle_intervals (vehicle_id, lower(trim(service_type)));

-- ===== Row Level Security: nur Mitglieder des Workspace =====
alter table public.vehicles enable row level security;
alter table public.vehicle_services enable row level security;
alter table public.vehicle_intervals enable row level security;

create policy vehicles_workspace_members on public.vehicles
  for all to authenticated
  using (workspace_id in (select public.my_workspace_ids()))
  with check (workspace_id in (select public.my_workspace_ids()));

create policy vehicle_services_workspace_members on public.vehicle_services
  for all to authenticated
  using (vehicle_id in (select v.id from public.vehicles v
                        where v.workspace_id in (select public.my_workspace_ids())))
  with check (
    vehicle_id in (select v.id from public.vehicles v
                   where v.workspace_id in (select public.my_workspace_ids()))
    -- Beleg muss ein Dokument aus dem eigenen Workspace sein
    and (document_id is null or document_id in (select d.id from public.documents d
                                                where d.workspace_id in (select public.my_workspace_ids())))
  );

create policy vehicle_intervals_workspace_members on public.vehicle_intervals
  for all to authenticated
  using (vehicle_id in (select v.id from public.vehicles v
                        where v.workspace_id in (select public.my_workspace_ids())))
  with check (vehicle_id in (select v.id from public.vehicles v
                             where v.workspace_id in (select public.my_workspace_ids())));
