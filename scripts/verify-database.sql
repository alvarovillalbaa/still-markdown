-- Still database-enforcement checks only. Run the WHOLE file as the project
-- administrator in one connection. This does not sign up users, issue sessions,
-- validate JWTs, test HTTP/MCP transport, or prove browser behavior.
--
-- No DDL, passwords, email addresses, external calls, or Auth settings changes.
-- Two id-only auth.users fixtures exist solely to satisfy ownership foreign
-- keys. Transaction-local role/claim settings model database request contexts.
-- A deliberate exception rolls back the entire fixture/test subtransaction on
-- success. Unexpected exceptions propagate and also roll back that block. The
-- final ROLLBACK closes the surrounding transaction on the successful path.
begin;

do $verify$
declare
  v_original_role text := current_user;
  -- These random, reserved fixture IDs are repeated in the post-ROLLBACK query.
  -- Refuse to touch either ID if it already exists; never reuse an existing user.
  v_a uuid := '13bfa0d7-4d36-40a6-b5a8-c9d7d4ae32b7';
  v_b uuid := '09c6cddd-d9b6-4727-bcee-1f481d097b29';
  v_doc_a uuid := gen_random_uuid();
  v_doc_b uuid := gen_random_uuid();
  v_mcp_doc uuid;
  v_read_token uuid;
  v_write_token uuid;
  v_b_token uuid;
  v_expired_token uuid := gen_random_uuid();
  v_read_hash text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_write_hash text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_b_hash text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expired_hash text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_unknown_hash text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_marker text := 'still-database-verification-' || gen_random_uuid()::text;
  v_checks text[] := '{}'::text[];
  v_result jsonb;
  v_next jsonb;
  v_count bigint;
  v_affected bigint;
  v_denied boolean;
  v_rolled_back boolean := false;
begin
  -- All writes and role/claim changes are inside this exception subtransaction.
  begin
    if (current_user = 'postgres' and session_user = 'postgres') is not true then
      raise exception 'Database verification requires the dedicated project postgres connection';
    end if;
    if exists (select 1 from auth.users where id in (v_a, v_b))
      or exists (select 1 from public.documents where user_id in (v_a, v_b))
      or exists (select 1 from public.mcp_tokens where user_id in (v_a, v_b)) then
      raise exception 'Reserved verification fixture IDs must be absent before this test';
    end if;
    if exists (
      select 1 from pg_roles where rolname in ('anon', 'authenticated')
      and (rolsuper or rolbypassrls)
    ) then raise exception 'Public request roles must not bypass RLS'; end if;
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'still_private'
        and p.proname in ('save_owned_document', 'mcp_dispatch')
        and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) then raise exception 'Private helper execution must be revoked'; end if;
    if (not has_schema_privilege('anon', 'still_private', 'USAGE')
      and not has_schema_privilege('authenticated', 'still_private', 'USAGE')) is not true then
      raise exception 'Private helper schema must be inaccessible to request roles';
    end if;
    v_checks := array_append(v_checks, 'public roles cannot bypass RLS or execute private helpers');

    insert into auth.users (id) values (v_a), (v_b);
    -- A past-created/past-expiring capability satisfies the storage constraint
    -- and lets expiry be checked without sleeps or changing a server clock.
    insert into public.mcp_tokens (id, user_id, name, token_hash, scope, created_at, expires_at)
      values (v_expired_token, v_a, 'rollback-only expired capability', v_expired_hash,
        'read', now() - interval '2 days', now() - interval '1 day');

    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    if (current_user = 'authenticated' and auth.uid() = v_a
      and row_security_active('public.documents') and row_security_active('public.mcp_tokens')) is not true then
      raise exception 'Authenticated owner A context must have active RLS';
    end if;
    v_result := public.save_document(v_doc_a, 'A fixture', 'A original ' || v_marker, null);
    if ((v_result->>'id')::uuid = v_doc_a and (v_result->>'user_id')::uuid = v_a
      and (v_result->>'version')::integer = 1) is not true then raise exception 'A create RPC ownership/version assertion failed'; end if;
    v_result := public.save_document(v_doc_a, 'A fixture', 'A updated ' || v_marker, 1);
    if ((v_result->>'version')::integer = 2 and v_result->>'markdown' = 'A updated ' || v_marker) is not true then
      raise exception 'A save RPC version assertion failed';
    end if;
    v_checks := array_append(v_checks, 'owner A creates and updates through versioned save RPC');

    v_denied := false;
    begin
      perform public.save_document(v_doc_a, 'Stale A', 'must not replace A', 1);
    exception when sqlstate '40001' then
      if sqlerrm <> 'document_version_conflict' then raise; end if;
      v_denied := true;
    end;
    select count(*) into v_count from public.documents
      where id = v_doc_a and version = 2 and markdown = 'A updated ' || v_marker;
    if (v_denied and v_count = 1) is not true then raise exception 'Stale save must fail and preserve A content'; end if;
    v_checks := array_append(v_checks, 'stale browser-style save rejects expected_version and preserves newer content');

    insert into public.mcp_tokens (user_id, name, token_hash)
      values (v_a, 'rollback-only A default-read', v_read_hash) returning id into v_read_token;
    insert into public.mcp_tokens (user_id, name, token_hash, scope)
      values (v_a, 'rollback-only A write', v_write_hash, 'write') returning id into v_write_token;
    select count(id) into v_count from public.mcp_tokens where id = v_read_token and scope = 'read';
    if v_count <> 1 then raise exception 'Token scope must default to read'; end if;
    v_checks := array_append(v_checks, 'authenticated owner can create scoped capabilities with default read access');

    v_denied := false;
    begin
      perform token_hash from public.mcp_tokens where id = v_read_token;
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Token hash column must be hidden even from its owner'; end if;
    v_checks := array_append(v_checks, 'token owner cannot select token_hash');
    v_denied := false;
    begin
      insert into public.mcp_tokens (user_id, name, token_hash)
        values (v_b, 'forged owner must fail', v_unknown_hash);
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Token insertion must not forge ownership'; end if;
    v_checks := array_append(v_checks, 'token insertion rejects a forged owner');
    v_denied := false;
    begin
      update public.mcp_tokens set scope = 'write' where id = v_read_token;
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Direct token scope escalation must be forbidden'; end if;
    v_checks := array_append(v_checks, 'direct token update cannot escalate capability scope');

    v_denied := false;
    begin
      insert into public.documents (id, user_id, title, markdown)
        values (gen_random_uuid(), v_a, 'Direct insert must fail', 'forbidden');
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Direct document insert must be forbidden'; end if;
    v_denied := false;
    begin
      update public.documents set markdown = 'Direct update must fail' where id = v_doc_a;
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Direct document update must be forbidden'; end if;
    v_checks := array_append(v_checks, 'direct document INSERT and UPDATE cannot bypass versioned saves');

    v_denied := false;
    begin
      perform still_private.save_owned_document(v_b, gen_random_uuid(), 'Private helper must fail', '', null);
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Authenticated direct private save helper must be denied'; end if;
    v_denied := false;
    begin
      perform still_private.mcp_dispatch(v_write_hash, 'authorize', '{}'::jsonb);
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Authenticated direct private MCP helper must be denied'; end if;
    v_checks := array_append(v_checks, 'authenticated role cannot invoke either private helper');

    perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', '', true);
    v_denied := false;
    begin
      perform public.save_document(gen_random_uuid(), 'Missing owner', '', null);
    exception when sqlstate '28000' then
      if sqlerrm <> 'authentication_required' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'A role without a user identity must not save'; end if;
    v_checks := array_append(v_checks, 'save RPC fails closed when authenticated role has no user claim');

    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    if auth.uid() is distinct from v_b then raise exception 'Owner B request context was not established'; end if;
    v_result := public.save_document(v_doc_b, 'B fixture', 'B original ' || v_marker, null);
    if ((v_result->>'user_id')::uuid = v_b and (v_result->>'version')::integer = 1) is not true then
      raise exception 'B create RPC assertion failed';
    end if;
    v_result := public.save_document(v_doc_b, 'B fixture', 'B updated ' || v_marker, 1);
    if ((v_result->>'version')::integer = 2) is not true then raise exception 'B save RPC assertion failed'; end if;
    insert into public.mcp_tokens (user_id, name, token_hash)
      values (v_b, 'rollback-only B read', v_b_hash) returning id into v_b_token;
    v_checks := array_append(v_checks, 'owner B independently creates and updates an owned page');
    select count(*) into v_count from public.documents;
    if v_count <> 1 then raise exception 'B must see exactly its own fixture page'; end if;
    select count(*) into v_count from public.documents where id = v_doc_a;
    if v_count <> 0 then raise exception 'B must not read A page'; end if;
    select count(id) into v_count from public.mcp_tokens;
    if v_count <> 1 then raise exception 'B must not list A capabilities'; end if;
    v_checks := array_append(v_checks, 'B document and token SELECT policies hide all A rows');
    v_denied := false;
    begin
      perform public.save_document(v_doc_a, 'B must not save A', 'forbidden', 2);
    exception when sqlstate 'P0002' then
      if sqlerrm <> 'document_not_found' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'B must not update A through save RPC'; end if;
    delete from public.documents where id = v_doc_a;
    get diagnostics v_affected = row_count;
    if v_affected <> 0 then raise exception 'B must not delete A page'; end if;
    delete from public.mcp_tokens where id = v_read_token;
    get diagnostics v_affected = row_count;
    if v_affected <> 0 then raise exception 'B must not revoke A capability'; end if;
    v_checks := array_append(v_checks, 'B cannot save/delete A page or revoke A capability');

    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    select count(*) into v_count from public.documents;
    if v_count <> 1 then raise exception 'A must see exactly its own fixture page'; end if;
    select count(*) into v_count from public.documents where id = v_doc_b;
    if v_count <> 0 then raise exception 'A must not read B page'; end if;
    select count(id) into v_count from public.mcp_tokens;
    if v_count <> 3 then raise exception 'A token list must contain only A live and expired fixtures'; end if;
    delete from public.documents where id = v_doc_b;
    get diagnostics v_affected = row_count;
    if v_affected <> 0 then raise exception 'A must not delete B page'; end if;
    v_checks := array_append(v_checks, 'A document/token SELECT and DELETE policies isolate B rows');

    execute 'set local role anon';
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    if (current_user = 'anon' and auth.uid() is null) is not true then raise exception 'Anonymous request context was not established'; end if;
    v_denied := false;
    begin perform id from public.documents;
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Anonymous direct document SELECT must be denied'; end if;
    v_denied := false;
    begin perform id from public.mcp_tokens;
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Anonymous direct token SELECT must be denied'; end if;
    v_denied := false;
    begin perform public.save_document(gen_random_uuid(), 'Anonymous save must fail', '', null);
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Anonymous save RPC execution must be denied'; end if;
    v_denied := false;
    begin perform still_private.mcp_dispatch(v_write_hash, 'authorize', '{}'::jsonb);
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'Anonymous private MCP helper execution must be denied'; end if;
    v_checks := array_append(v_checks, 'anon cannot read tables, execute save RPC, or invoke private MCP helper');

    v_result := public.mcp_dispatch(v_read_hash, 'authorize', '{}'::jsonb);
    if (v_result->>'scope' = 'read') is not true then raise exception 'Read capability authorization failed'; end if;
    v_result := public.mcp_dispatch(v_read_hash, 'list', '{}'::jsonb);
    if (jsonb_array_length(v_result->'documents') = 1
      and (v_result->'documents'->0->>'id')::uuid = v_doc_a) is not true then
      raise exception 'MCP list must return only A page';
    end if;
    v_result := public.mcp_dispatch(v_read_hash, 'search', jsonb_build_object('query', v_marker));
    if (jsonb_array_length(v_result->'documents') = 1
      and (v_result->'documents'->0->>'id')::uuid = v_doc_a) is not true then
      raise exception 'MCP search must return only A page';
    end if;
    v_result := public.mcp_dispatch(v_read_hash, 'get', jsonb_build_object('id', v_doc_a));
    if (v_result->>'markdown' = 'A updated ' || v_marker and (v_result->>'version')::integer = 2) is not true then
      raise exception 'MCP read content/version assertion failed';
    end if;
    v_checks := array_append(v_checks, 'valid read capability authorizes/lists/searches/reads only its owner pages as anon');
    v_denied := false;
    begin perform public.mcp_dispatch(v_read_hash, 'get', jsonb_build_object('id', v_doc_b));
    exception when sqlstate 'P0002' then
      if sqlerrm <> 'document_not_found' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'A capability must not read B page'; end if;
    v_result := public.mcp_dispatch(v_b_hash, 'get', jsonb_build_object('id', v_doc_b));
    if ((v_result->>'user_id')::uuid = v_b and v_result->>'markdown' = 'B updated ' || v_marker) is not true then
      raise exception 'B capability must remain valid for B page';
    end if;
    v_denied := false;
    begin perform public.mcp_dispatch(v_b_hash, 'get', jsonb_build_object('id', v_doc_a));
    exception when sqlstate 'P0002' then
      if sqlerrm <> 'document_not_found' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'B capability must not read A page'; end if;
    v_checks := array_append(v_checks, 'capability owner isolation holds in both directions');

    v_denied := false;
    begin perform public.mcp_dispatch(v_read_hash, 'create', jsonb_build_object('title', 'Read token cannot create', 'markdown', 'forbidden'));
    exception when insufficient_privilege then
      if sqlerrm <> 'read_only_connection' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'Read capability must not create'; end if;
    v_denied := false;
    begin perform public.mcp_dispatch(v_read_hash, 'update', jsonb_build_object('id', v_doc_a, 'title', 'Read token cannot save', 'markdown', 'forbidden', 'expected_version', 2));
    exception when insufficient_privilege then
      if sqlerrm <> 'read_only_connection' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'Read capability must not update'; end if;
    v_checks := array_append(v_checks, 'read capabilities reject both creation and update');

    v_result := public.mcp_dispatch(v_write_hash, 'create', jsonb_build_object('title', 'MCP fixture', 'markdown', 'MCP original ' || v_marker));
    v_mcp_doc := (v_result->>'id')::uuid;
    if (v_mcp_doc is not null and (v_result->>'user_id')::uuid = v_a
      and (v_result->>'version')::integer = 1) is not true then raise exception 'Write capability create assertion failed'; end if;
    v_result := public.mcp_dispatch(v_write_hash, 'update', jsonb_build_object('id', v_mcp_doc, 'title', 'MCP fixture', 'markdown', 'MCP version two', 'expected_version', 1));
    if ((v_result->>'version')::integer = 2) is not true then raise exception 'MCP version increment failed'; end if;
    v_denied := false;
    begin perform public.mcp_dispatch(v_write_hash, 'update', jsonb_build_object('id', v_mcp_doc, 'title', 'Stale MCP', 'markdown', 'must not replace MCP', 'expected_version', 1));
    exception when sqlstate '40001' then
      if sqlerrm <> 'document_version_conflict' then raise; end if;
      v_denied := true;
    end;
    v_result := public.mcp_dispatch(v_read_hash, 'get', jsonb_build_object('id', v_mcp_doc));
    if (v_denied and (v_result->>'version')::integer = 2 and v_result->>'markdown' = 'MCP version two') is not true then
      raise exception 'Stale MCP save must preserve newer content';
    end if;
    v_checks := array_append(v_checks, 'write capability creates/updates and stale MCP save preserves newer content');
    v_denied := false;
    begin perform public.mcp_dispatch(v_write_hash, 'update', jsonb_build_object('id', v_doc_b, 'title', 'Wrong owner', 'markdown', 'forbidden', 'expected_version', 2));
    exception when sqlstate 'P0002' then
      if sqlerrm <> 'document_not_found' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'Write capability must not update another owner'; end if;
    v_checks := array_append(v_checks, 'write capability cannot modify another owner page');
    v_result := public.mcp_dispatch(v_read_hash, 'list', jsonb_build_object('limit', 1));
    v_next := public.mcp_dispatch(v_read_hash, 'list', jsonb_build_object('limit', 1, 'cursor', v_result->>'next_cursor'));
    if (jsonb_array_length(v_result->'documents') = 1 and jsonb_array_length(v_next->'documents') = 1
      and v_result->'documents'->0->>'id' <> v_next->'documents'->0->>'id') is not true then
      raise exception 'MCP bounded pagination must return distinct owner pages';
    end if;
    v_checks := array_append(v_checks, 'MCP bounded pagination traverses owner pages');

    v_denied := false;
    begin perform public.mcp_dispatch(v_unknown_hash, 'authorize', '{}'::jsonb);
    exception when sqlstate '28000' then
      if sqlerrm <> 'invalid_connection_token' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'Unknown capability must not authorize'; end if;
    v_denied := false;
    begin perform public.mcp_dispatch(v_expired_hash, 'get', jsonb_build_object('id', v_doc_a));
    exception when sqlstate '28000' then
      if sqlerrm <> 'invalid_connection_token' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'Expired capability must not read'; end if;
    v_checks := array_append(v_checks, 'unknown and expired capabilities fail closed');

    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    v_result := public.save_document(v_mcp_doc, 'MCP fixture', 'Browser version three', 2);
    if ((v_result->>'version')::integer = 3) is not true then raise exception 'Browser-style save must share the MCP version counter'; end if;
    v_denied := false;
    begin perform public.mcp_dispatch(v_write_hash, 'update', jsonb_build_object('id', v_mcp_doc, 'title', 'Stale after browser', 'markdown', 'forbidden', 'expected_version', 2));
    exception when sqlstate '40001' then
      if sqlerrm <> 'document_version_conflict' then raise; end if;
      v_denied := true;
    end;
    v_result := public.mcp_dispatch(v_read_hash, 'get', jsonb_build_object('id', v_mcp_doc));
    if (v_denied and v_result->>'markdown' = 'Browser version three' and (v_result->>'version')::integer = 3) is not true then
      raise exception 'MCP must not overwrite a newer browser-style RPC save';
    end if;
    v_checks := array_append(v_checks, 'browser-style and MCP RPCs share one conflict-protected version counter');
    delete from public.mcp_tokens where id = v_read_token;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then raise exception 'Owner must be able to revoke its capability'; end if;
    v_denied := false;
    begin perform public.mcp_dispatch(v_read_hash, 'authorize', '{}'::jsonb);
    exception when sqlstate '28000' then
      if sqlerrm <> 'invalid_connection_token' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'Revoked capability must not authorize'; end if;
    v_checks := array_append(v_checks, 'owner revocation immediately invalidates a capability');
    delete from public.documents where id = v_doc_a;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then raise exception 'A must be able to delete its own page'; end if;
    v_denied := false;
    begin perform public.mcp_dispatch(v_write_hash, 'get', jsonb_build_object('id', v_doc_a));
    exception when sqlstate 'P0002' then
      if sqlerrm <> 'document_not_found' then raise; end if;
      v_denied := true;
    end;
    if not v_denied then raise exception 'Deleted page must not remain accessible through MCP'; end if;
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_b::text, true);
    select count(*) into v_count from public.documents where id = v_doc_b and version = 2 and markdown = 'B updated ' || v_marker;
    if v_count <> 1 then raise exception 'Cross-owner operations must preserve B content'; end if;
    delete from public.documents where id = v_doc_b;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then raise exception 'B must be able to delete its own page'; end if;
    v_checks := array_append(v_checks, 'both owners can delete their own pages while other-owner content remains protected');

    -- This is the only intentional control-flow exception. Its handler is below.
    raise sqlstate 'ST001' using message = 'still_database_verification_rollback';
  exception when sqlstate 'ST001' then
    if sqlerrm <> 'still_database_verification_rollback' then raise; end if;
    v_rolled_back := true;
  end;

  -- The inner exception has already undone fixtures, pages, tokens, and local
  -- role/claim changes. Verify their absence under the original administrator.
  if (v_rolled_back and current_user = v_original_role) is not true then
    raise exception 'Fixture rollback must restore the original database role';
  end if;
  select count(*) into v_count from auth.users where id in (v_a, v_b);
  if v_count <> 0 then raise exception 'Synthetic Auth foreign-key fixtures were not rolled back'; end if;
  select count(*) into v_count from public.documents where user_id in (v_a, v_b);
  if v_count <> 0 then raise exception 'Synthetic documents were not rolled back'; end if;
  select count(*) into v_count from public.mcp_tokens where user_id in (v_a, v_b);
  if v_count <> 0 then raise exception 'Synthetic capabilities were not rolled back'; end if;
  v_checks := array_append(v_checks, 'all synthetic users/documents/tokens were rolled back and original role restored');
  raise notice 'Still database verification passed % assertion groups; all fixtures already rolled back', cardinality(v_checks);
end;
$verify$;

rollback;

-- execute_sql returns only the final statement's rows. This statement runs after
-- ROLLBACK, reads no transaction-local report state, and counts only the reserved
-- fixture IDs checked absent before insertion. An unhandled assertion error in
-- DO aborts the submitted query before this summary can execute. The list below
-- names assertions completed by the straight-through DO body, not separate tests.
with assertion_groups as (
  select array[
    'public roles cannot bypass RLS or execute private helpers',
    'owner A creates and updates through versioned save RPC',
    'stale browser-style save rejects expected_version and preserves newer content',
    'authenticated owner can create scoped capabilities with default read access',
    'token owner cannot select token_hash',
    'token insertion rejects a forged owner',
    'direct token update cannot escalate capability scope',
    'direct document INSERT and UPDATE cannot bypass versioned saves',
    'authenticated role cannot invoke either private helper',
    'save RPC fails closed when authenticated role has no user claim',
    'owner B independently creates and updates an owned page',
    'B document and token SELECT policies hide all A rows',
    'B cannot save/delete A page or revoke A capability',
    'A document/token SELECT and DELETE policies isolate B rows',
    'anon cannot read tables, execute save RPC, or invoke private MCP helper',
    'valid read capability authorizes/lists/searches/reads only its owner pages as anon',
    'capability owner isolation holds in both directions',
    'read capabilities reject both creation and update',
    'write capability creates/updates and stale MCP save preserves newer content',
    'write capability cannot modify another owner page',
    'MCP bounded pagination traverses owner pages',
    'unknown and expired capabilities fail closed',
    'browser-style and MCP RPCs share one conflict-protected version counter',
    'owner revocation immediately invalidates a capability',
    'both owners can delete their own pages while other-owner content remains protected',
    'all synthetic users/documents/tokens were rolled back and original role restored'
  ]::text[] as checks
), residue as (
  select
    (select count(*) from auth.users where id in ('13bfa0d7-4d36-40a6-b5a8-c9d7d4ae32b7'::uuid, '09c6cddd-d9b6-4727-bcee-1f481d097b29'::uuid)) as auth_users,
    (select count(*) from public.documents where user_id in ('13bfa0d7-4d36-40a6-b5a8-c9d7d4ae32b7'::uuid, '09c6cddd-d9b6-4727-bcee-1f481d097b29'::uuid)) as documents,
    (select count(*) from public.mcp_tokens where user_id in ('13bfa0d7-4d36-40a6-b5a8-c9d7d4ae32b7'::uuid, '09c6cddd-d9b6-4727-bcee-1f481d097b29'::uuid)) as mcp_tokens
)
select jsonb_build_object(
  'passed', residue.auth_users = 0 and residue.documents = 0 and residue.mcp_tokens = 0,
  'checks_passed', cardinality(assertion_groups.checks),
  'checks', to_jsonb(assertion_groups.checks),
  'fixture_residue_after_rollback', to_jsonb(residue),
  'proof_boundary', 'Installed PostgreSQL role grants, RLS, sequential version conflicts and capability RPC enforcement only. Simulated transaction-local claims are not public signup, JWT validation, Auth sessions, HTTP/MCP transport, concurrent-client, or browser proof.'
) as database_verification
from assertion_groups cross join residue;
