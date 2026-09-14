-- Categorias de acesso, separacao entre fotos/documentos e receitas culinarias.

insert into public.permission_definitions (code, resource, action, description) values
  ('photos.view', 'photos', 'view', 'Visualizar fotos'),
  ('photos.create', 'photos', 'create', 'Adicionar fotos'),
  ('photos.edit', 'photos', 'edit', 'Editar fotos'),
  ('photos.delete', 'photos', 'delete', 'Excluir fotos'),
  ('recipes.view', 'recipes', 'view', 'Visualizar receitas culinarias'),
  ('recipes.create', 'recipes', 'create', 'Criar receitas culinarias'),
  ('recipes.edit', 'recipes', 'edit', 'Editar receitas culinarias'),
  ('recipes.delete', 'recipes', 'delete', 'Excluir receitas culinarias')
on conflict (code) do update set
  resource = excluded.resource,
  action = excluded.action,
  description = excluded.description;

alter table public.family_memberships drop constraint if exists family_memberships_role_check;
alter table public.family_memberships add constraint family_memberships_role_check
  check (role in ('admin','father','mother','guardian','caregiver','grandparent','doctor','friend','visitor','custom'));

alter table public.role_permissions drop constraint if exists role_permissions_role_check;
alter table public.role_permissions add constraint role_permissions_role_check
  check (role in ('father','mother','guardian','caregiver','grandparent','doctor','friend','visitor','custom'));

create table if not exists public.family_role_permissions (
  family_id uuid not null references public.families(id) on delete cascade,
  role text not null check (role in ('caregiver','grandparent','doctor','friend','visitor','custom')),
  permission_code text not null references public.permission_definitions(code) on delete cascade,
  allowed boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (family_id, role, permission_code)
);
create index if not exists family_role_permissions_family_role_idx
  on public.family_role_permissions (family_id, role);
alter table public.family_role_permissions enable row level security;
grant select on public.family_role_permissions to authenticated;
revoke insert, update, delete on public.family_role_permissions from authenticated, anon;
drop policy if exists family_role_permissions_select on public.family_role_permissions;
create policy family_role_permissions_select on public.family_role_permissions
  for select to authenticated
  using (
    exists (
      select 1 from public.family_memberships m
      where m.family_id = family_role_permissions.family_id
        and m.user_id = (select auth.uid())
        and m.active = true
        and (m.ends_at is null or m.ends_at > now())
    )
  );

create or replace function app.is_family_admin(target_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.is_current_user_active() and exists (
    select 1 from public.family_memberships m
    where m.family_id = target_family_id
      and m.user_id = (select auth.uid())
      and m.role in ('admin','father','mother')
      and m.active = true
      and (m.ends_at is null or m.ends_at > now())
  );
$$;

create or replace function app.has_permission(target_family_id uuid, target_resource text, target_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_membership uuid;
  membership_role text;
  override_allowed boolean;
begin
  if not app.is_current_user_active() then return false; end if;

  select m.id, m.role into current_membership, membership_role
  from public.family_memberships m
  where m.family_id = target_family_id
    and m.user_id = (select auth.uid())
    and m.active = true
    and (m.ends_at is null or m.ends_at > now())
  limit 1;

  if current_membership is null then return false; end if;
  if membership_role in ('admin','father','mother') then return true; end if;

  select mp.allowed into override_allowed
  from public.membership_permissions mp
  join public.permission_definitions pd on pd.code = mp.permission_code
  where mp.membership_id = current_membership
    and pd.resource = target_resource
    and pd.action = target_action
  limit 1;
  if override_allowed is not null then return override_allowed; end if;

  select frp.allowed into override_allowed
  from public.family_role_permissions frp
  join public.permission_definitions pd on pd.code = frp.permission_code
  where frp.family_id = target_family_id
    and frp.role = membership_role
    and pd.resource = target_resource
    and pd.action = target_action
  limit 1;
  if override_allowed is not null then return override_allowed; end if;

  return exists (
    select 1
    from public.role_permissions rp
    join public.permission_definitions pd on pd.code = rp.permission_code
    where rp.role = membership_role
      and rp.allowed = true
      and pd.resource = target_resource
      and pd.action = target_action
  );
end;
$$;

create or replace function public.set_role_permission(
  target_family_id uuid,
  target_role text,
  target_permission_code text,
  target_allowed boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_resource text;
  target_action text;
begin
  if not app.is_family_admin(target_family_id) then
    raise exception 'administrator permission required';
  end if;
  if target_role not in ('caregiver','grandparent','doctor','friend','visitor','custom') then
    raise exception 'invalid configurable role';
  end if;

  select resource, action into target_resource, target_action
  from public.permission_definitions where code = target_permission_code;
  if target_resource is null then raise exception 'unknown permission'; end if;

  insert into public.family_role_permissions
    (family_id, role, permission_code, allowed, updated_by)
  values
    (target_family_id, target_role, target_permission_code, target_allowed, (select auth.uid()))
  on conflict (family_id, role, permission_code)
  do update set allowed = excluded.allowed, updated_at = now(), updated_by = excluded.updated_by;

  -- Qualquer acao concedida tambem concede visualizacao.
  if target_allowed and target_action <> 'view' then
    insert into public.family_role_permissions
      (family_id, role, permission_code, allowed, updated_by)
    select target_family_id, target_role, pd.code, true, (select auth.uid())
    from public.permission_definitions pd
    where pd.resource = target_resource and pd.action = 'view'
    on conflict (family_id, role, permission_code)
    do update set allowed = true, updated_at = now(), updated_by = excluded.updated_by;
  end if;

  -- Sem visualizacao, nenhuma outra acao do modulo permanece liberada.
  if not target_allowed and target_action = 'view' then
    insert into public.family_role_permissions
      (family_id, role, permission_code, allowed, updated_by)
    select target_family_id, target_role, pd.code, false, (select auth.uid())
    from public.permission_definitions pd
    where pd.resource = target_resource
    on conflict (family_id, role, permission_code)
    do update set allowed = false, updated_at = now(), updated_by = excluded.updated_by;
  end if;
end;
$$;
revoke all on function public.set_role_permission(uuid,text,text,boolean) from public, anon;
grant execute on function public.set_role_permission(uuid,text,text,boolean) to authenticated;

-- Pai e mae possuem acesso total; os demais perfis partem de defaults seguros.
insert into public.role_permissions (role, permission_code, allowed)
select parent_role, pd.code, true
from (values ('father'), ('mother')) as parents(parent_role)
cross join public.permission_definitions pd
on conflict (role, permission_code) do update set allowed = true;

delete from public.role_permissions
where role = 'caregiver' and permission_code in ('files.view','files.create','files.download','files.edit','files.delete','health.edit','health.manage');
insert into public.role_permissions (role, permission_code, allowed) values
  ('caregiver','photos.view',true),
  ('caregiver','photos.create',true),
  ('caregiver','recipes.view',true),
  ('grandparent','daily_logs.view',true),
  ('grandparent','events.view',true),
  ('grandparent','photos.view',true),
  ('grandparent','recipes.view',true),
  ('doctor','child.view',true),
  ('doctor','contacts.view',true),
  ('doctor','events.view',true),
  ('doctor','health.view',true),
  ('doctor','medications.view',true),
  ('doctor','files.view',true),
  ('doctor','files.download',true),
  ('friend','photos.view',true),
  ('friend','recipes.view',true),
  ('guardian','photos.view',true),
  ('guardian','photos.create',true),
  ('guardian','photos.edit',true),
  ('guardian','photos.delete',true),
  ('guardian','recipes.view',true),
  ('guardian','recipes.create',true),
  ('guardian','recipes.edit',true),
  ('guardian','recipes.delete',true)
on conflict (role, permission_code) do update set allowed = excluded.allowed;

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 160),
  category text not null default 'other' check (category in ('breakfast','lunch','snack','dinner','dessert','drink','other')),
  ingredients jsonb not null default '[]'::jsonb check (jsonb_typeof(ingredients) = 'array'),
  instructions text not null default '',
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  notes text not null default '',
  allergy_alert text not null default '',
  photo_file_id uuid references public.files(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
create index if not exists recipes_family_title_idx on public.recipes (family_id, title);
alter table public.recipes enable row level security;
grant select, insert, update, delete on public.recipes to authenticated;
revoke all on public.recipes from anon;
drop policy if exists recipes_select on public.recipes;
drop policy if exists recipes_insert on public.recipes;
drop policy if exists recipes_update on public.recipes;
drop policy if exists recipes_delete on public.recipes;
create policy recipes_select on public.recipes for select to authenticated
  using (app.has_permission(family_id, 'recipes', 'view'));
create policy recipes_insert on public.recipes for insert to authenticated
  with check (app.has_permission(family_id, 'recipes', 'create') and created_by = (select auth.uid()));
create policy recipes_update on public.recipes for update to authenticated
  using (app.has_permission(family_id, 'recipes', 'edit'))
  with check (app.has_permission(family_id, 'recipes', 'edit'));
create policy recipes_delete on public.recipes for delete to authenticated
  using (app.has_permission(family_id, 'recipes', 'delete'));

create or replace function app.file_resource(target_file_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(target_file_type, '') ~* '(photo|image|avatar)' then 'photos'
    else 'files'
  end;
$$;

create or replace function app.has_file_permission(target_file_id uuid, target_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_family_id uuid;
  target_file_type text;
  owner_id uuid;
  membership_role text;
  required_action text;
  required_resource text;
begin
  select f.family_id, f.file_type, f.uploaded_by
    into target_family_id, target_file_type, owner_id
  from public.files f where f.id = target_file_id;

  if target_family_id is null or not app.is_current_user_active() then return false; end if;
  select m.role into membership_role
  from public.family_memberships m
  where m.family_id = target_family_id
    and m.user_id = (select auth.uid())
    and m.active = true
    and (m.ends_at is null or m.ends_at > now())
  limit 1;
  if membership_role is null then return false; end if;

  required_resource := app.file_resource(target_file_type);
  required_action := case target_action
    when 'view' then 'view'
    when 'download' then case when required_resource = 'photos' then 'view' else 'download' end
    when 'replace' then 'edit'
    when 'metadata' then 'edit'
    when 'archive' then 'delete'
    when 'restore' then 'delete'
    when 'delete' then 'delete'
    else null
  end;
  if required_action is null or not app.has_permission(target_family_id, required_resource, required_action) then return false; end if;

  if exists (
    select 1 from public.file_permissions fp
    where fp.file_id = target_file_id and fp.allowed = false and (
      (fp.subject_type = 'user' and fp.subject_value = (select auth.uid())::text) or
      (fp.subject_type = 'role' and fp.subject_value = membership_role) or
      (fp.subject_type = 'author' and owner_id = (select auth.uid())) or
      (fp.subject_type = 'caregivers' and membership_role = 'caregiver') or
      (fp.subject_type = 'guardians' and membership_role in ('guardian','father','mother')) or
      (fp.subject_type = 'admins' and membership_role in ('admin','father','mother'))
    )
  ) then return false; end if;
  return true;
end;
$$;

drop function if exists public.assert_file_list_access();
create or replace function public.assert_file_list_access(target_scope text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare target_family_id uuid;
begin
  select family_id into target_family_id from public.family_memberships
  where user_id=(select auth.uid()) and active=true and (ends_at is null or ends_at>now()) limit 1;
  if target_family_id is null then raise exception 'file view permission required'; end if;
  if target_scope = 'photos' and not app.has_permission(target_family_id,'photos','view') then raise exception 'photo view permission required'; end if;
  if target_scope = 'documents' and not app.has_permission(target_family_id,'files','view') then raise exception 'file view permission required'; end if;
  if target_scope is null and not (
    app.has_permission(target_family_id,'photos','view') or app.has_permission(target_family_id,'files','view')
  ) then raise exception 'file view permission required'; end if;
  if target_scope not in ('photos','documents') then raise exception 'invalid file scope'; end if;
  return target_family_id;
end;
$$;

drop function if exists public.assert_file_upload_access();
create or replace function public.assert_file_upload_access(target_file_type text default 'document')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_family_id uuid;
  target_resource text;
begin
  select m.family_id into target_family_id
  from public.family_memberships m
  where m.user_id = (select auth.uid()) and m.active = true
    and (m.ends_at is null or m.ends_at > now()) limit 1;
  target_resource := app.file_resource(target_file_type);
  if target_family_id is null or not app.has_permission(target_family_id, target_resource, 'create') then
    raise exception 'file upload permission required';
  end if;
  return target_family_id;
end;
$$;

revoke all on function public.assert_file_list_access(text) from public, anon;
revoke all on function public.assert_file_upload_access(text) from public, anon;
grant execute on function public.assert_file_list_access(text) to authenticated;
grant execute on function public.assert_file_upload_access(text) to authenticated;

drop policy if exists files_select on public.files;
drop policy if exists files_insert on public.files;
drop policy if exists files_update on public.files;
drop policy if exists files_delete on public.files;
create policy files_select on public.files for select to authenticated
  using (app.has_permission(family_id, app.file_resource(file_type), 'view'));
create policy files_insert on public.files for insert to authenticated
  with check (app.has_permission(family_id, app.file_resource(file_type), 'create'));
create policy files_update on public.files for update to authenticated
  using (app.has_permission(family_id, app.file_resource(file_type), 'edit'))
  with check (app.has_permission(family_id, app.file_resource(file_type), 'edit'));
create policy files_delete on public.files for delete to authenticated
  using (app.has_permission(family_id, app.file_resource(file_type), 'delete'));

drop policy if exists events_select on public.calendar_events;
create policy events_select on public.calendar_events for select to authenticated
using (
  app.has_permission(family_id, 'events', 'view') and exists (
    select 1 from public.family_memberships m
    where m.family_id = calendar_events.family_id
      and m.user_id = (select auth.uid())
      and m.active = true
      and (m.ends_at is null or m.ends_at > now())
      and (
        m.role in ('admin','father','mother','guardian')
        or calendar_events.audience_role = 'all'
        or (calendar_events.audience_role = 'family' and m.role in ('grandparent','friend'))
        or calendar_events.audience_role = m.role
      )
  )
);

drop policy if exists care_tasks_select on public.care_tasks;
create policy care_tasks_select on public.care_tasks for select to authenticated
using (
  app.has_permission(family_id, 'tasks', 'view') and (
    exists (
      select 1 from public.family_memberships m
      where m.family_id = care_tasks.family_id
        and m.user_id = (select auth.uid())
        and m.role in ('admin','father','mother','guardian')
        and m.active = true
    )
    or assigned_role in ('caregiver','all')
    or assigned_to = (select auth.uid())
  )
);

create or replace function public.add_existing_member(target_family_id uuid, target_email text, target_role text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user_id uuid;
  membership_id uuid;
begin
  if not app.is_family_admin(target_family_id) then raise exception 'administrator permission required'; end if;
  if target_role not in ('admin','father','mother','guardian','caregiver','grandparent','doctor','friend','visitor','custom') then
    raise exception 'invalid role';
  end if;
  select u.id into target_user_id from auth.users u
  where lower(u.email) = lower(trim(target_email)) and u.email_confirmed_at is not null limit 1;
  if target_user_id is null then raise exception 'confirmed user not found'; end if;
  insert into public.family_memberships (family_id,user_id,role,active,created_by)
  values (target_family_id,target_user_id,target_role,true,(select auth.uid()))
  on conflict (family_id,user_id) do update set role=excluded.role,active=true,ends_at=null
  returning id into membership_id;
  return membership_id;
end;
$$;

-- Converte os responsaveis existentes sem incluir dados pessoais na migracao.
update public.family_memberships set role = 'father' where role = 'admin';
update public.family_memberships m
set role = 'mother'
from public.profiles p
where p.user_id = m.user_id and m.role = 'guardian'
  and lower(translate(p.relationship_to_child,'ãáâä','aaaa')) = 'mae';
