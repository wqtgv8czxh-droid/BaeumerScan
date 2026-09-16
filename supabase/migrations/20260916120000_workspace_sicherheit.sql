-- Sicherheits-Reparatur Workspaces
-- Vorher: workspaces und workspace_members waren für JEDEN les- und schreibbar
-- (Policy "true"). Dadurch konnte sich jeder in den Familien-Workspace eintragen und
-- alle Dokumente sehen. Storage-Dateien waren für jeden angemeldeten Nutzer lesbar.
-- Nachher: Zugriff nur für Mitglieder des jeweiligen Workspace. Beitreten nur über
-- einen Einladungscode (7 Tage gültig, einmal nutzbar), eigener Workspace nur über RPC.

-- ===== Hilfsfunktion: Workspaces des angemeldeten Nutzers =====
-- security definer, damit Policies auf workspace_members sich nicht selbst abfragen (Rekursion).
create or replace function public.my_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id from public.workspace_members m where m.user_id = auth.uid()
$$;
revoke all on function public.my_workspace_ids() from public, anon;
grant execute on function public.my_workspace_ids() to authenticated;

-- ===== Alte, offene Policies entfernen =====
drop policy if exists workspace_full_access on public.workspaces;
drop policy if exists members_full_access on public.workspace_members;
drop policy if exists members_see_own_workspace on public.workspace_members;
drop policy if exists workspace_members_only on public.documents;

-- ===== Neue Policies =====
-- Workspaces und Mitglieder: nur lesen, nur eigene. Anlegen/Beitreten läuft über die Funktionen unten.
create policy workspaces_select_own on public.workspaces
  for select to authenticated
  using (id in (select public.my_workspace_ids()));

create policy members_select_same_workspace on public.workspace_members
  for select to authenticated
  using (workspace_id in (select public.my_workspace_ids()));

create policy documents_workspace_members on public.documents
  for all to authenticated
  using (workspace_id in (select public.my_workspace_ids()))
  with check (workspace_id in (select public.my_workspace_ids()));

-- ===== Storage: Dateien liegen unter "<workspace_id>/..." =====
drop policy if exists storage_read on storage.objects;
drop policy if exists storage_upload on storage.objects;
drop policy if exists storage_delete on storage.objects;

create policy documents_bucket_select on storage.objects
  for select to authenticated
  using (bucket_id = 'documents'
    and (storage.foldername(name))[1] in (select w::text from public.my_workspace_ids() w));

create policy documents_bucket_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents'
    and (storage.foldername(name))[1] in (select w::text from public.my_workspace_ids() w));

create policy documents_bucket_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents'
    and (storage.foldername(name))[1] in (select w::text from public.my_workspace_ids() w));

-- ===== Einladungen =====
create table public.workspace_invites (
  token text primary key default encode(extensions.gen_random_bytes(24), 'hex'),
  workspace_id uuid not null references public.workspaces(id),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users(id),
  used_at timestamptz
);
-- RLS an, keine Policies: Zugriff ausschließlich über die Funktionen
alter table public.workspace_invites enable row level security;

-- Einladungscode erzeugen (nur Mitglieder des Workspace)
create or replace function public.create_workspace_invite(p_workspace_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not exists (select 1 from public.workspace_members m
                 where m.workspace_id = p_workspace_id and m.user_id = auth.uid()) then
    raise exception 'Kein Mitglied dieses Workspace';
  end if;
  insert into public.workspace_invites (workspace_id, created_by)
  values (p_workspace_id, auth.uid())
  returning token into v_token;
  return v_token;
end
$$;

-- Einladung einlösen: prüft Code, trägt Nutzer als Mitglied ein, entwertet den Code
create or replace function public.accept_workspace_invite(p_token text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.workspace_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  select * into v_invite from public.workspace_invites i where i.token = p_token for update;
  if not found or v_invite.used_at is not null or v_invite.expires_at < now() then
    raise exception 'Einladungslink ist ungültig oder abgelaufen';
  end if;
  if not exists (select 1 from public.workspace_members m
                 where m.workspace_id = v_invite.workspace_id and m.user_id = auth.uid()) then
    insert into public.workspace_members (workspace_id, user_id, display_name)
    values (v_invite.workspace_id, auth.uid(), nullif(trim(p_display_name), ''));
  end if;
  update public.workspace_invites set used_by = auth.uid(), used_at = now() where token = p_token;
  return v_invite.workspace_id;
end
$$;

-- Eigenen Workspace anlegen (nur wenn der Nutzer noch in keinem ist)
create or replace function public.create_own_workspace(p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  select m.workspace_id into v_ws from public.workspace_members m where m.user_id = auth.uid() limit 1;
  if v_ws is not null then
    return v_ws;
  end if;
  insert into public.workspaces (name) values ('Bäumer Familie') returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, display_name)
  values (v_ws, auth.uid(), nullif(trim(p_display_name), ''));
  return v_ws;
end
$$;

revoke all on function public.create_workspace_invite(uuid) from public, anon;
revoke all on function public.accept_workspace_invite(text, text) from public, anon;
revoke all on function public.create_own_workspace(text) from public, anon;
grant execute on function public.create_workspace_invite(uuid) to authenticated;
grant execute on function public.accept_workspace_invite(text, text) to authenticated;
grant execute on function public.create_own_workspace(text) to authenticated;
