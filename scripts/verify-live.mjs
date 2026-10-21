#!/usr/bin/env node
// Deliberately opt-in: this creates disposable real Auth accounts and private data.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mcpHandler from '../api/mcp.js';
import { publicConfig } from '../lib/supabase.js';

if (!process.argv.includes('--allow-live')) {
  process.stderr.write('Live verification requires the explicit --allow-live argument.\n');
  process.exit(2);
}

const endpointArgument = process.argv.find((arg) => arg.startsWith('--endpoint='));
let endpoint;
if (endpointArgument) {
  try {
    endpoint = new URL(endpointArgument.slice('--endpoint='.length));
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) throw new Error();
    if (endpoint.pathname === '/') endpoint.pathname = '/api/mcp';
  } catch {
    process.stderr.write('The optional --endpoint must be an HTTPS MCP URL without credentials, query, or fragment.\n');
    process.exit(2);
  }
}

const config = publicConfig();
if (!config.configured) {
  process.stderr.write('A valid Supabase publishable configuration is required.\n');
  process.exit(2);
}

const prefix = `still-live-${Date.now()}-${randomBytes(4).toString('hex')}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_FIELDS = 'id,user_id,name,scope,expires_at,created_at';
const checks = [];
const accounts = [];
const cleanup = [];
const diagnostics = [];
const secretValues = new Set([config.publishableKey]);
let authSettings;
let failure;
let nextRpcId = 1;
const deadline = new AbortController();
const deadlineTimer = setTimeout(() => deadline.abort(), 360_000);

function check(condition, name) {
  if (!condition) throw new Error(`Check failed: ${name}`);
  checks.push(name);
}
function phase(name) { process.stdout.write(`${JSON.stringify({ event: 'live_verification_phase', phase: name })}\n`); }
function safeAccount(account) { return { id: account.id || null, email: account.email }; }
function trackSensitive(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /password|token|authorization|apikey|secret/i.test(key) && item.length > 3) {
      secretValues.add(item);
      if (/^Bearer /i.test(item)) secretValues.add(item.slice(7));
    } else if (item && typeof item === 'object') trackSensitive(item, depth + 1);
  }
}
function safePublicMessage(value) {
  let message = typeof value === 'string' ? value : '';
  for (const secret of secretValues) message = message.split(secret).join('[redacted]');
  return message
    .replace(/(?:sb_(?:secret|publishable)_[A-Za-z0-9_-]+|still_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_.~+/=-]+/gi, '[redacted authorization]')
    .replace(/(?:password|access_token|refresh_token|token_hash|api[_-]?key|authorization|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&<>]+)/gi, '[redacted credential]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; } })
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted long value]')
    .replace(/<[^>]{0,1000}>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}
function publicError(data) {
  const value = data?.msg || data?.message || data?.error_description || data?.error?.message || data?.error;
  return safePublicMessage(typeof value === 'string' ? value : '');
}
function publicCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && safePublicMessage(value) === value) return value;
  return undefined;
}
function statusHint(result) {
  const value = publicCode(result.data?.code ?? result.data?.error_code ?? result.data?.error?.code);
  const code = value === undefined ? '' : `, code ${value}`;
  const message = result.diagnostic?.message || (!result.ok ? publicError(result.data) : '');
  return `HTTP ${result.status}${code}${message ? `, message ${message}` : ''}`;
}

async function http(url, { method = 'GET', headers = {}, body, cleanupRequest = false } = {}) {
  trackSensitive(headers);
  trackSensitive(body);
  let response;
  try {
    response = await fetch(url, {
      method, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', credentials: 'omit',
      signal: cleanupRequest ? AbortSignal.timeout(15_000) : AbortSignal.any([deadline.signal, AbortSignal.timeout(15_000)]),
    });
  } catch { throw new Error('Live HTTP request failed or timed out.'); }
  let text;
  try {
    const chunks = [];
    let bytes = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 2_097_152) throw new Error();
        chunks.push(Buffer.from(chunk));
      }
    }
    text = Buffer.concat(chunks).toString('utf8');
  } catch { throw new Error('Live HTTP response was interrupted or exceeded its limit.'); }
  let data = null;
  let parsed = false;
  try { if (text.trim()) { data = JSON.parse(text); parsed = true; } } catch { /* Only a sanitized error excerpt can enter the report. */ }
  trackSensitive(data);
  let diagnostic;
  if (!response.ok) {
    const code = publicCode(data?.code ?? data?.error_code ?? data?.error?.code);
    diagnostic = {
      operation: `${method} ${new URL(url).pathname}`,
      status: response.status,
      content_type: safePublicMessage(response.headers.get('content-type') || '').slice(0, 96),
      json_kind: parsed ? (data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data) : text.trim() ? 'unparsed' : 'empty',
      ...(code === undefined ? {} : { code }),
      message: publicError(data) || safePublicMessage(text),
    };
    if (diagnostics.length < 100) diagnostics.push(diagnostic);
  }
  return { status: response.status, ok: response.ok, data, ...(diagnostic ? { diagnostic } : {}) };
}

function api(path, { account, ...options } = {}) {
  return http(`${config.url}${path}`, {
    ...options,
    headers: { apikey: config.publishableKey, ...(account?.accessToken ? { Authorization: `Bearer ${account.accessToken}` } : {}), ...options.headers },
  });
}

async function createAccount(suffix) {
  const account = { email: `${prefix}-${suffix}@example.com`, password: `Aa!${randomBytes(32).toString('base64url')}` };
  accounts.push(account);
  const signup = await api('/auth/v1/signup', { method: 'POST', body: { email: account.email, password: account.password } });
  const id = signup.data?.user?.id || signup.data?.id;
  if (UUID.test(id || '')) {
    account.id = id;
    process.stdout.write(`${JSON.stringify({ event: 'synthetic_account_cleanup_receipt', prefix, account: safeAccount(account) })}\n`);
  }
  account.accessToken = signup.data?.access_token;
  check(signup.ok && account.id && account.accessToken, `${suffix}: public signup returns a session without confirmation email (${statusHint(signup)})`);
  const signin = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: account.email, password: account.password } });
  check(signin.ok && signin.data?.user?.id === account.id && typeof signin.data?.access_token === 'string', `${suffix}: password sign-in returns the same Auth user (${statusHint(signin)})`);
  account.accessToken = signin.data.access_token;
  const user = await api('/auth/v1/user', { account });
  check(user.ok && user.data?.id === account.id, `${suffix}: authenticated user endpoint verifies the session`);
  return account;
}

async function save(account, id, title, markdown, version) {
  return api('/rest/v1/rpc/save_document', {
    account, method: 'POST', body: { p_id: id, p_title: title, p_markdown: markdown, p_expected_version: version },
  });
}
async function readPage(account, id) {
  return api(`/rest/v1/documents?select=id,user_id,title,markdown,version&id=eq.${id}`, { account });
}
async function createToken(account, scope, name, expiresAt = new Date(Date.now() + 86_400_000).toISOString()) {
  const value = `still_${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(value).digest('hex');
  const result = await api(`/rest/v1/mcp_tokens?select=${TOKEN_FIELDS}`, {
    account, method: 'POST', headers: { Prefer: 'return=representation' },
    body: { user_id: account.id, name, scope, token_hash: tokenHash, expires_at: expiresAt },
  });
  check(result.ok && UUID.test(result.data?.[0]?.id || '') && result.data[0].user_id === account.id && !Object.hasOwn(result.data[0], 'token_hash'), `${name}: create scoped token with safe metadata only`);
  return { value, id: result.data[0].id, scope, expiresAt, hash: tokenHash };
}

async function localMcp(message, token, { method = 'POST', headers = {} } = {}) {
  const req = {
    method, body: message,
    headers: { host: 'still-live.invalid', 'x-forwarded-proto': 'https', 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token.value || token}` } : {}), ...headers },
  };
  const res = { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(body = '') { this.body = body; } };
  await mcpHandler(req, res);
  let data = null;
  try { if (res.body) data = JSON.parse(res.body); } catch { throw new Error('Imported MCP handler returned invalid JSON.'); }
  return { status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data };
}
function hostedMcp(message, token, { method = 'POST', headers = {} } = {}) {
  return http(endpoint.href, {
    method,
    ...(method === 'GET' ? {} : { body: message }),
    headers: { Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token.value || token}` } : {}), ...headers },
  });
}
function rpc(method, params = {}) { return { jsonrpc: '2.0', id: nextRpcId++, method, params }; }
async function tool(send, token, name, args) {
  return send(rpc('tools/call', { name, arguments: args }), token);
}
function toolData(result) { return result.data?.result?.structuredContent; }
function toolSucceeded(result) { return result.ok && result.data?.result?.isError === false; }
function toolRejected(result) { return result.ok && result.data?.result?.isError === true; }

async function verifyMcp(label, send, { a, b, aPage, bPage, readToken, writeToken, bToken }) {
  phase(`mcp_${label}`);
  for (const protocolVersion of ['2025-06-18', '2025-11-25']) {
    const initialized = await send(rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'still-live-verifier', version: '1' } }), readToken);
    check(initialized.ok && initialized.data?.result?.protocolVersion === protocolVersion, `${label}: initialize ${protocolVersion} with a real token`);
  }
  const notification = await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, readToken);
  check(notification.status === 202 && notification.data === null, `${label}: authenticated notification returns empty 202`);
  const discovered = await send(rpc('tools/list'), readToken);
  const names = discovered.data?.result?.tools?.map((entry) => entry.name) || [];
  check(discovered.ok && names.includes('get_document') && !names.includes('create_document') && !names.includes('update_document'), `${label}: read-only discovery excludes writing tools`);
  const writable = await send(rpc('tools/list'), writeToken);
  const writeNames = writable.data?.result?.tools?.map((entry) => entry.name) || [];
  check(writable.ok && writeNames.includes('create_document') && writeNames.includes('update_document'), `${label}: write discovery includes creation and update`);
  const list = await tool(send, readToken, 'list_documents', {});
  const listed = toolData(list)?.documents || [];
  check(toolSucceeded(list) && listed.some((doc) => doc.id === aPage.id) && !listed.some((doc) => doc.id === bPage.id), `${label}: list returns only token-owner pages`);
  const search = await tool(send, readToken, 'search_documents', { query: prefix });
  check(toolSucceeded(search) && toolData(search)?.documents?.some((doc) => doc.id === aPage.id) && !toolData(search)?.documents?.some((doc) => doc.id === bPage.id), `${label}: search finds only owner private Markdown`);
  const get = await tool(send, readToken, 'get_document', { id: aPage.id });
  check(toolSucceeded(get) && toolData(get)?.markdown === aPage.markdown, `${label}: read returns exact Markdown`);
  const deniedA = await tool(send, readToken, 'get_document', { id: bPage.id });
  const deniedB = await tool(send, bToken, 'get_document', { id: aPage.id });
  check(toolRejected(deniedA) && toolRejected(deniedB), `${label}: both tokens reject other-owner pages`);
  const otherWrite = await tool(send, writeToken, 'update_document', { id: bPage.id, title: 'Wrong owner', markdown: 'Must not overwrite B', expected_version: bPage.version });
  const bUnchanged = await readPage(b, bPage.id);
  check(toolRejected(otherWrite) && bUnchanged.ok && bUnchanged.data?.[0]?.markdown === bPage.markdown && bUnchanged.data[0].version === bPage.version, `${label}: write token cannot update another owner's page`);
  const resources = await send(rpc('resources/list'), readToken);
  check(resources.ok && resources.data?.result?.resources?.some((item) => item.uri === `still://documents/${aPage.id}`) && !resources.data?.result?.resources?.some((item) => item.uri === `still://documents/${bPage.id}`), `${label}: resources respect owner isolation`);
  const resource = await send(rpc('resources/read', { uri: `still://documents/${aPage.id}` }), readToken);
  check(resource.ok && resource.data?.result?.contents?.[0]?.text === aPage.markdown, `${label}: resource read returns exact Markdown`);
  const readWriteDenied = await tool(send, readToken, 'create_document', { title: 'Forbidden', markdown: prefix });
  check(toolRejected(readWriteDenied), `${label}: direct write invocation rejects a read token`);
  const missing = await send(rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} }));
  const invalid = await send(rpc('tools/list'), `still_${randomBytes(32).toString('base64url')}`);
  check(missing.status === 401 && invalid.status === 401, `${label}: missing and invalid tokens fail discovery`);
  const origin = await send(rpc('ping'), readToken, { headers: { origin: 'https://untrusted.still-live.invalid', Origin: 'https://untrusted.still-live.invalid' } });
  check(origin.status === 403, `${label}: untrusted Origin is rejected`);
  const getTransport = await send(undefined, readToken, { method: 'GET' });
  check(getTransport.status === 405, `${label}: GET explicitly rejects SSE`);

  const created = await tool(send, writeToken, 'create_document', { title: `${prefix} ${label}`, markdown: `# MCP-created\n\n${prefix}` });
  const createdPage = toolData(created);
  check(toolSucceeded(created) && UUID.test(createdPage?.id || '') && createdPage.version === 1 && createdPage.user_id === a.id, `${label}: write token creates an owner-scoped page`);
  const updated = await tool(send, writeToken, 'update_document', { id: createdPage.id, title: createdPage.title, markdown: 'MCP version two', expected_version: 1 });
  check(toolSucceeded(updated) && toolData(updated)?.version === 2, `${label}: write token advances the page version`);
  const stale = await tool(send, writeToken, 'update_document', { id: createdPage.id, title: 'Stale', markdown: 'Must not overwrite', expected_version: 1 });
  check(toolRejected(stale), `${label}: stale MCP update is rejected`);
  const browser = await save(a, createdPage.id, createdPage.title, 'Browser version three', 2);
  check(browser.ok && browser.data?.version === 3, `${label}: browser RPC can edit an MCP-created page`);
  const afterBrowser = await tool(send, writeToken, 'update_document', { id: createdPage.id, title: 'Stale MCP', markdown: 'Must not overwrite browser', expected_version: 2 });
  const retained = await tool(send, readToken, 'get_document', { id: createdPage.id });
  check(toolRejected(afterBrowser) && toolSucceeded(retained) && toolData(retained)?.version === 3 && toolData(retained)?.markdown === 'Browser version three', `${label}: browser and MCP version conflicts preserve newer content`);
}

try {
  phase('auth_settings_preflight');
  const settings = await api('/auth/v1/settings');
  const flag = (value) => typeof value === 'boolean' ? value : null;
  authSettings = {
    status: settings.status,
    email_provider_enabled: flag(settings.data?.external?.email),
    disable_signup: flag(settings.data?.disable_signup),
    mailer_autoconfirm: flag(settings.data?.mailer_autoconfirm),
    phone_autoconfirm: flag(settings.data?.phone_autoconfirm),
  };
  process.stdout.write(`${JSON.stringify({ event: 'public_auth_settings_preflight', ...authSettings, ...(!settings.ok ? { error: statusHint(settings) } : {}) })}\n`);
  check(settings.ok && settings.data && typeof settings.data === 'object', `public Auth settings are reachable (${statusHint(settings)})`);
  check(authSettings.email_provider_enabled === true && authSettings.disable_signup === false, 'public Auth settings enable email signup');
  check(authSettings.mailer_autoconfirm === true, 'public Auth settings confirm signup will not require or send a confirmation email');
  phase('signup_and_sessions');
  const a = await createAccount('a');
  const b = await createAccount('b');
  check(a.id !== b.id, 'independent signup creates two distinct account owners');
  phase('document_ownership_and_versions');
  const aId = randomUUID();
  const bId = randomUUID();
  const aCreated = await save(a, aId, `${prefix} A`, `# Private A\n\n${prefix}`, null);
  const bCreated = await save(b, bId, `${prefix} B`, `# Private B\n\n${prefix}`, null);
  check(aCreated.ok && aCreated.data?.id === aId && aCreated.data?.user_id === a.id && aCreated.data?.version === 1, 'A creates a private version-one page through save RPC');
  check(bCreated.ok && bCreated.data?.id === bId && bCreated.data?.user_id === b.id && bCreated.data?.version === 1, 'B creates a private version-one page through save RPC');
  for (const [account, ownId, otherId, label] of [[a, aId, bId, 'A'], [b, bId, aId, 'B']]) {
    const list = await api('/rest/v1/documents?select=id,user_id,title,markdown,version', { account });
    check(list.ok && Array.isArray(list.data) && list.data.some((doc) => doc.id === ownId) && list.data.every((doc) => doc.user_id === account.id) && !list.data.some((doc) => doc.id === otherId), `${label}: REST list contains only owned pages`);
    const other = await readPage(account, otherId);
    check(other.ok && Array.isArray(other.data) && other.data.length === 0, `${label}: REST read cannot see another owner's page`);
  }
  const anon = await api('/rest/v1/documents?select=id');
  check(!anon.ok && [401, 403].includes(anon.status), 'anonymous REST cannot select private documents');
  const directInsert = await api('/rest/v1/documents', { account: a, method: 'POST', body: { id: randomUUID(), user_id: a.id, title: 'Bypass', markdown: 'Forbidden' } });
  check(!directInsert.ok && directInsert.data?.code === '42501', 'direct REST document insert is forbidden');
  const directUpdate = await api(`/rest/v1/documents?id=eq.${aId}`, { account: a, method: 'PATCH', body: { title: 'Bypass version' } });
  check(!directUpdate.ok && directUpdate.data?.code === '42501', 'direct REST document update is forbidden');
  const otherSave = await save(b, aId, 'Wrong owner', 'Must not save', 1);
  check(!otherSave.ok && otherSave.data?.code === 'P0002', 'save RPC rejects another owner');
  const otherDelete = await api(`/rest/v1/documents?id=eq.${aId}`, { account: b, method: 'DELETE' });
  const afterDelete = await readPage(a, aId);
  check(otherDelete.ok && afterDelete.ok && afterDelete.data?.[0]?.id === aId, 'other-owner REST delete does not remove the page');
  const saved = await save(a, aId, `${prefix} A`, `# Updated private A\n\n${prefix}`, 1);
  check(saved.ok && saved.data?.version === 2, 'owner RPC save atomically increments version');
  const stale = await save(a, aId, 'Stale', 'Must not overwrite', 1);
  const retained = await readPage(a, aId);
  check(!stale.ok && stale.data?.code === '40001' && retained.data?.[0]?.markdown === saved.data.markdown && retained.data[0].version === 2, 'stale browser RPC conflicts and preserves the newer Markdown');

  phase('scoped_tokens_and_column_privileges');
  const readToken = await createToken(a, 'read', 'A read token');
  const writeToken = await createToken(a, 'write', 'A write token');
  const bToken = await createToken(b, 'read', 'B read token');
  const shortToken = await createToken(a, 'read', 'A expiry token', new Date(Date.now() + 15_000).toISOString());
  const activeShortToken = await localMcp(rpc('ping'), shortToken);
  check(activeShortToken.ok && activeShortToken.data?.result && !activeShortToken.data.error, 'short-lived token works before its expiry');
  const metadata = await api(`/rest/v1/mcp_tokens?select=${TOKEN_FIELDS}`, { account: a });
  check(metadata.ok && Array.isArray(metadata.data) && metadata.data.length === 3 && metadata.data.every((row) => row.user_id === a.id && !Object.hasOwn(row, 'token_hash')), 'token metadata lists only owner records without hashes');
  const hashes = await api('/rest/v1/mcp_tokens?select=token_hash', { account: a });
  check(!hashes.ok && hashes.data?.code === '42501', 'authenticated owners cannot select token hashes');
  const anonymousTokens = await api(`/rest/v1/mcp_tokens?select=${TOKEN_FIELDS}`);
  check(!anonymousTokens.ok && [401, 403].includes(anonymousTokens.status), 'anonymous users cannot select token metadata');
  const otherTokens = await api(`/rest/v1/mcp_tokens?select=${TOKEN_FIELDS}&id=eq.${readToken.id}`, { account: b });
  check(otherTokens.ok && Array.isArray(otherTokens.data) && otherTokens.data.length === 0, 'token metadata is hidden from another account');
  const escalate = await api(`/rest/v1/mcp_tokens?id=eq.${readToken.id}`, { account: a, method: 'PATCH', body: { scope: 'write' } });
  check(!escalate.ok && escalate.data?.code === '42501', 'a read token cannot be escalated through direct table update');
  const otherRevoke = await api(`/rest/v1/mcp_tokens?id=eq.${readToken.id}`, { account: b, method: 'DELETE' });
  const ownerTokenStillWorks = await localMcp(rpc('ping'), readToken);
  check(otherRevoke.ok && ownerTokenStillWorks.ok && ownerTokenStillWorks.data?.result, 'another owner cannot revoke a connection');
  const forgedOwner = await api(`/rest/v1/mcp_tokens?select=${TOKEN_FIELDS}`, {
    account: b, method: 'POST', body: { user_id: a.id, name: 'Must be rejected', scope: 'write', token_hash: createHash('sha256').update(randomBytes(32)).digest('hex') },
  });
  check(!forgedOwner.ok && forgedOwner.data?.code === '42501', 'token insertion cannot forge another account owner');
  const anonymousDispatch = await api('/rest/v1/rpc/mcp_dispatch', { method: 'POST', body: { p_token_hash: '0'.repeat(64), p_action: 'authorize', p_args: {} } });
  check(!anonymousDispatch.ok && anonymousDispatch.data?.code === '28000', 'public MCP RPC rejects an unknown capability digest');

  const suite = { a, b, aPage: saved.data, bPage: bCreated.data, readToken, writeToken, bToken };
  const transports = [['imported_handler', localMcp], ...(endpoint ? [['hosted_http', hostedMcp]] : [])];
  for (const [label, send] of transports) await verifyMcp(label, send, suite);
  phase('revocation_and_expiry');
  const revoke = await api(`/rest/v1/mcp_tokens?id=eq.${readToken.id}`, { account: a, method: 'DELETE' });
  check(revoke.ok, 'owner can revoke a connection with REST DELETE');
  for (const [label, send] of transports) {
    const revoked = await send(rpc('tools/list'), readToken);
    check(revoked.status === 401, `${label}: revoked token cannot discover tools`);
  }
  const wait = Math.max(0, new Date(shortToken.expiresAt).getTime() - Date.now() + 500);
  if (wait) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 16_000)));
  for (const [label, send] of transports) {
    const expired = await send(rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} }), shortToken);
    check(expired.status === 401, `${label}: expired token cannot initialize`);
  }
} catch (error) {
  // Only our own bounded errors reach logs; never print response bodies or secrets.
  failure = error instanceof Error && /^(Check failed: |Live HTTP |Imported MCP )/.test(error.message)
    ? error.message : 'Live verification failed unexpectedly.';
} finally {
  clearTimeout(deadlineTimer);
  phase('cleanup');
  for (const account of accounts) {
    if (!account.id || !account.accessToken) {
      cleanup.push({ account_id: account.id || null, tokens_deleted: false, pages_deleted: false, signed_out: false });
      continue;
    }
    const record = { account_id: account.id, tokens_deleted: false, pages_deleted: false, signed_out: false };
    try { record.tokens_deleted = (await api(`/rest/v1/mcp_tokens?user_id=eq.${account.id}`, { account, method: 'DELETE', cleanupRequest: true })).ok; } catch { /* Report cleanup failure without secrets. */ }
    try { record.pages_deleted = (await api(`/rest/v1/documents?user_id=eq.${account.id}`, { account, method: 'DELETE', cleanupRequest: true })).ok; } catch { /* Root has the account ID for cleanup. */ }
    try {
      const tokens = await api(`/rest/v1/mcp_tokens?select=id&user_id=eq.${account.id}`, { account, cleanupRequest: true });
      const pages = await api(`/rest/v1/documents?select=id&user_id=eq.${account.id}`, { account, cleanupRequest: true });
      record.tokens_deleted &&= tokens.ok && Array.isArray(tokens.data) && tokens.data.length === 0;
      record.pages_deleted &&= pages.ok && Array.isArray(pages.data) && pages.data.length === 0;
    } catch { record.tokens_deleted = false; record.pages_deleted = false; }
    try { record.signed_out = (await api('/auth/v1/logout?scope=global', { account, method: 'POST', cleanupRequest: true })).ok; } catch { /* Root can remove the dedicated Auth user. */ }
    cleanup.push(record);
  }
}

const cleanupComplete = cleanup.length === accounts.length && cleanup.every((entry) => entry.tokens_deleted && entry.pages_deleted && entry.signed_out);
const report = {
  event: 'still_live_verification_report', passed: !failure && cleanupComplete,
  project: new URL(config.url).hostname, endpoint: endpoint?.href || null, prefix,
  auth_settings: authSettings || null, diagnostics,
  checks_passed: checks.length, checks, ...(failure ? { failure } : {}),
  accounts_requiring_admin_deletion: accounts.map(safeAccount), cleanup,
  proof_boundary: endpoint ? 'Real public signup/signin, REST ownership/version enforcement, and imported plus hosted HTTP MCP. Browser UI and email delivery are not exercised.' : 'Real public signup/signin, REST ownership/version enforcement, and imported MCP handler against live Supabase. Hosted HTTP and browser UI are not exercised.',
  evidence_artifact: 'artifacts/live-evidence.json',
};
try {
  const artifactDirectory = resolve('artifacts');
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(resolve(artifactDirectory, 'live-evidence.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
} catch {
  report.passed = false;
  report.evidence_artifact_error = 'Could not write the safe live evidence artifact.';
}
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.passed) throw new Error('Live verification failed; see the safe JSON report and clean up its synthetic Auth account IDs.');
