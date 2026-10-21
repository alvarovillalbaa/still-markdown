-- Still's initial schema. Apply to the dedicated Still Supabase project.
-- The only SECURITY DEFINER entrypoints are explicitly granted RPC wrappers.
begin;

create schema if not exists still_private;
revoke all on schema still_private from public, anon, authenticated;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '' check (char_length(title) <= 240),
  markdown text not null default '' check (octet_length(markdown) <= 1048576),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists documents_owner_updated_idx on public.documents (user_id, updated_at desc, id);
alter table public.documents enable row level security;
revoke all on public.documents from public, anon, authenticated;
grant select, delete on public.documents to authenticated;
drop policy if exists documents_read_own on public.documents;
create policy documents_read_own on public.documents for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists documents_delete_own on public.documents;
create policy documents_delete_own on public.documents for delete to authenticated
  using ((select auth.uid()) = user_id);
-- Direct INSERT/UPDATE are deliberately unavailable: every save checks a version.

create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scope text not null default 'read' check (scope in ('read', 'write')),
  expires_at timestamptz not null default (now() + interval '90 days'),
  created_at timestamptz not null default now(),
  check (expires_at > created_at and expires_at <= created_at + interval '366 days')
);
create index if not exists mcp_tokens_owner_idx on public.mcp_tokens (user_id);
alter table public.mcp_tokens enable row level security;
revoke all on public.mcp_tokens from public, anon, authenticated;
grant select (id, user_id, name, scope, expires_at, created_at) on public.mcp_tokens to authenticated;
grant insert (user_id, name, token_hash, scope, expires_at) on public.mcp_tokens to authenticated;
grant delete on public.mcp_tokens to authenticated;
drop policy if exists mcp_tokens_read_own on public.mcp_tokens;
create policy mcp_tokens_read_own on public.mcp_tokens for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists mcp_tokens_insert_own on public.mcp_tokens;
create policy mcp_tokens_insert_own on public.mcp_tokens for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists mcp_tokens_delete_own on public.mcp_tokens;
create policy mcp_tokens_delete_own on public.mcp_tokens for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Internal helper. Callers cannot choose an owner through an exposed API.
create or replace function still_private.save_owned_document(
  p_user_id uuid, p_id uuid, p_title text, p_markdown text, p_expected_version integer
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
begin
  if p_user_id is null then raise sqlstate '28000' using message = 'authentication_required'; end if;
  if p_title is null or char_length(p_title) > 240 or p_markdown is null or octet_length(p_markdown) > 1048576 then
    raise sqlstate '22023' using message = 'invalid_document';
  end if;
  if p_expected_version is null then
    insert into public.documents (id, user_id, title, markdown)
      values (coalesce(p_id, gen_random_uuid()), p_user_id, p_title, p_markdown)
      on conflict (id) do nothing returning * into v_document;
    if not found then raise sqlstate '40001' using message = 'document_version_conflict'; end if;
  else
    if p_id is null or p_expected_version < 1 or p_expected_version >= 2147483647 then
      raise sqlstate '22023' using message = 'invalid_document_version';
    end if;
    update public.documents set title = p_title, markdown = p_markdown,
      version = version + 1, updated_at = clock_timestamp()
      where id = p_id and user_id = p_user_id and version = p_expected_version
      returning * into v_document;
    if not found then
      if exists (select 1 from public.documents where id = p_id and user_id = p_user_id) then
        raise sqlstate '40001' using message = 'document_version_conflict';
      end if;
      raise sqlstate 'P0002' using message = 'document_not_found';
    end if;
  end if;
  return to_jsonb(v_document);
end;
$$;
revoke all on function still_private.save_owned_document(uuid, uuid, text, text, integer) from public, anon, authenticated;

create or replace function public.save_document(
  p_id uuid, p_title text, p_markdown text, p_expected_version integer
) returns jsonb
language sql security definer
set search_path = ''
as $$
  select still_private.save_owned_document(auth.uid(), p_id, p_title, p_markdown, p_expected_version);
$$;
revoke all on function public.save_document(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.save_document(uuid, text, text, integer) to authenticated;

-- An opaque token is a bearer capability. Validate its digest, expiry, owner and
-- scope in this single transaction before any metadata, content or write action.
-- The share lock serializes token revocation with an operation already underway.
create or replace function still_private.mcp_dispatch(
  p_token_hash text, p_action text, p_args jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_token public.mcp_tokens%rowtype;
  v_document public.documents%rowtype;
  v_id uuid;
  v_limit integer;
  v_offset integer;
  v_rows jsonb;
  v_query text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise sqlstate '28000' using message = 'invalid_connection_token';
  end if;
  select * into v_token from public.mcp_tokens
    where token_hash = p_token_hash and expires_at > clock_timestamp() for share;
  if not found or not exists (select 1 from auth.users where id = v_token.user_id) then
    raise sqlstate '28000' using message = 'invalid_connection_token';
  end if;
  if p_action not in ('authorize', 'list', 'get', 'search', 'create', 'update') or p_action is null
     or jsonb_typeof(p_args) is distinct from 'object' or octet_length(p_args::text) > 2097152 then
    raise sqlstate '22023' using message = 'invalid_action';
  end if;
  if p_action in ('create', 'update') and v_token.scope <> 'write' then
    raise sqlstate '42501' using message = 'read_only_connection';
  end if;
  if p_action = 'authorize' then
    return jsonb_build_object('scope', v_token.scope, 'expires_at', v_token.expires_at);
  end if;
  if p_action in ('list', 'search') then
    if p_args ? 'limit' and (jsonb_typeof(p_args->'limit') <> 'number' or (p_args->>'limit') !~ '^[0-9]{1,3}$') then
      raise sqlstate '22023' using message = 'invalid_limit';
    end if;
    if p_args ? 'cursor' and (jsonb_typeof(p_args->'cursor') <> 'string' or (p_args->>'cursor') !~ '^[0-9]{1,7}$') then
      raise sqlstate '22023' using message = 'invalid_cursor';
    end if;
    v_limit := coalesce((p_args->>'limit')::integer, 50);
    v_offset := coalesce((p_args->>'cursor')::integer, 0);
    if v_limit not between 1 and 100 or v_offset not between 0 and 1000000 then
      raise sqlstate '22023' using message = 'invalid_pagination';
    end if;
    if p_action = 'search' then
      v_query := p_args->>'query';
      if jsonb_typeof(p_args->'query') is distinct from 'string' or char_length(btrim(v_query)) not between 1 and 200 then
        raise sqlstate '22023' using message = 'invalid_search_query';
      end if;
    end if;
    select coalesce(jsonb_agg(to_jsonb(page)), '[]'::jsonb) into v_rows from (
      select id, title, version, created_at, updated_at from public.documents
      where user_id = v_token.user_id
        and (p_action = 'list' or position(lower(v_query) in lower(title || E'\n' || markdown)) > 0)
      order by updated_at desc, id limit (v_limit + 1) offset v_offset
    ) page;
    return jsonb_build_object(
      'documents', case when jsonb_array_length(v_rows) > v_limit then v_rows - v_limit else v_rows end,
      'next_cursor', case when jsonb_array_length(v_rows) > v_limit then to_jsonb((v_offset + v_limit)::text) else 'null'::jsonb end
    );
  end if;
  if p_action in ('get', 'update') then
    if jsonb_typeof(p_args->'id') is distinct from 'string' then raise sqlstate '22023' using message = 'invalid_document_id'; end if;
    v_id := (p_args->>'id')::uuid;
  end if;
  if p_action = 'get' then
    select * into v_document from public.documents where id = v_id and user_id = v_token.user_id;
    if not found then raise sqlstate 'P0002' using message = 'document_not_found'; end if;
    return to_jsonb(v_document);
  end if;
  if jsonb_typeof(p_args->'title') is distinct from 'string' or jsonb_typeof(p_args->'markdown') is distinct from 'string' then
    raise sqlstate '22023' using message = 'invalid_document';
  end if;
  if p_action = 'create' then
    return still_private.save_owned_document(v_token.user_id, gen_random_uuid(), p_args->>'title', p_args->>'markdown', null);
  end if;
  if jsonb_typeof(p_args->'expected_version') is distinct from 'number' or (p_args->>'expected_version') !~ '^[0-9]{1,10}$' then
    raise sqlstate '22023' using message = 'invalid_document_version';
  end if;
  return still_private.save_owned_document(v_token.user_id, v_id, p_args->>'title', p_args->>'markdown', (p_args->>'expected_version')::integer);
end;
$$;
revoke all on function still_private.mcp_dispatch(text, text, jsonb) from public, anon, authenticated;

create or replace function public.mcp_dispatch(p_token_hash text, p_action text, p_args jsonb default '{}'::jsonb)
returns jsonb
language sql security definer
set search_path = ''
set statement_timeout = '10s'
as $$ select still_private.mcp_dispatch(p_token_hash, p_action, p_args); $$;
revoke all on function public.mcp_dispatch(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mcp_dispatch(text, text, jsonb) to anon, authenticated;

commit;
