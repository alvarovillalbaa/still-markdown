import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import handler from '../api/mcp.js';
import configHandler from '../api/config.js';

const TOKEN = `still_${'a'.repeat(43)}`;
const ID = 'fa272ecf-8b7c-41c1-9776-f02e2daa5ef6';
const CONFIG = { SUPABASE_URL: 'https://still-test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', APP_ORIGIN: 'https://still.example' };
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(Object.keys(CONFIG).map((key) => [key, process.env[key]]));

test.beforeEach(() => Object.assign(process.env, CONFIG));
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function response() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') { this.body = value; },
    get data() { return this.body ? JSON.parse(this.body) : null; },
  };
}
async function request(message, { method = 'POST', headers = {}, stream = false } = {}) {
  const req = stream ? Readable.from([typeof message === 'string' ? message : JSON.stringify(message)]) : { body: message };
  req.method = method;
  req.headers = { host: 'still.example', 'x-forwarded-proto': 'https', 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers };
  const res = response();
  await handler(req, res);
  return res;
}
function rpc(method, params = {}, id = 1) { return { jsonrpc: '2.0', id, method, params }; }
function mockRpc(callback = () => ({ scope: 'read' })) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `${CONFIG.SUPABASE_URL}/rest/v1/rpc/mcp_dispatch`);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.apikey, CONFIG.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.p_token_hash, createHash('sha256').update(TOKEN).digest('hex'));
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
    calls.push(body);
    const result = await callback(body, calls.length);
    return new Response(JSON.stringify(result.data ?? result), { status: result.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test('public configuration exposes only validated publishable credentials', () => {
  const res = response();
  configHandler({ method: 'GET' }, res);
  assert.deepEqual(res.data, { configured: true, url: CONFIG.SUPABASE_URL, publishableKey: CONFIG.SUPABASE_PUBLISHABLE_KEY, passwordRecoveryEnabled: false, revision: process.env.VERCEL_GIT_COMMIT_SHA || 'local' });
  assert.equal(res.headers['cache-control'], 'no-store');
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_secret_private';
  const rejected = response();
  configHandler({ method: 'GET' }, rejected);
  assert.deepEqual(rejected.data, { configured: false, url: '', publishableKey: '', passwordRecoveryEnabled: false, revision: process.env.VERCEL_GIT_COMMIT_SHA || 'local' });
});

test('authentication is required even for initialize and discovery', async () => {
  globalThis.fetch = () => assert.fail('Missing bearer credentials must not reach the database.');
  for (const method of ['initialize', 'tools/list', 'resources/list']) {
    const res = await request(rpc(method), { headers: { authorization: '' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.data.error.code, -32001);
    assert.match(res.headers['www-authenticate'], /^Bearer /);
  }
});

test('revoked or expired tokens cannot discover tools', async () => {
  const calls = mockRpc(() => ({ status: 401, data: { code: '28000', message: 'private upstream detail' } }));
  const res = await request(rpc('tools/list'));
  assert.equal(res.statusCode, 401);
  assert.equal(res.data.error.code, -32001);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p_action, 'authorize');
  assert.doesNotMatch(res.body, /private upstream detail/);
});

test('origin validation rejects cross-origin calls and permits the configured application', async () => {
  const calls = mockRpc();
  const blocked = await request(rpc('ping'), { headers: { origin: 'https://attacker.example' } });
  assert.equal(blocked.statusCode, 403);
  assert.equal(calls.length, 0);
  const allowed = await request(rpc('ping'), { headers: { host: 'preview.example', origin: CONFIG.APP_ORIGIN } });
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.data.result, {});
});

test('initialization negotiates both supported versions after authorizing the token', async () => {
  const calls = mockRpc();
  for (const protocolVersion of ['2025-06-18', '2025-11-25', 'unknown']) {
    const res = await request(rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.result.protocolVersion, protocolVersion === 'unknown' ? '2025-11-25' : protocolVersion);
    assert.deepEqual(res.data.result.capabilities, { tools: {}, resources: {} });
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.p_action === 'authorize'));
});

test('read-only discovery hides writes, and database authorization rejects direct write invocation', async () => {
  const calls = mockRpc(({ p_action }) => p_action === 'authorize'
    ? { scope: 'read' } : { status: 403, data: { code: '42501' } });
  const discovery = await request(rpc('tools/list'));
  assert.deepEqual(discovery.data.result.tools.map((tool) => tool.name), ['list_documents', 'get_document', 'search_documents']);
  const write = await request(rpc('tools/call', { name: 'create_document', arguments: { title: 'Page', markdown: 'Content' } }));
  assert.equal(write.statusCode, 200);
  assert.equal(write.data.result.isError, true);
  assert.match(write.data.result.content[0].text, /read access only/);
  assert.equal(calls.at(-1).p_action, 'create');
});

test('update passes the exact expected version and returns a newer saved document', async () => {
  const args = { id: ID, title: 'Versioned', markdown: 'Next text', expected_version: 41 };
  const calls = mockRpc(({ p_action }) => p_action === 'authorize' ? { scope: 'write' } : { id: ID, title: args.title, markdown: args.markdown, version: 42 });
  const res = await request(rpc('tools/call', { name: 'update_document', arguments: args }));
  assert.equal(res.data.result.isError, false);
  assert.equal(res.data.result.structuredContent.version, 42);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].p_action, 'update');
  assert.deepEqual(calls[1].p_args, args);
});

test('version conflict reports a tool error without pretending the document was saved', async () => {
  mockRpc(({ p_action }) => p_action === 'authorize' ? { scope: 'write' } : { status: 409, data: { code: '40001', message: 'document_version_conflict' } });
  const res = await request(rpc('tools/call', { name: 'update_document', arguments: { id: ID, title: 'Page', markdown: 'Draft', expected_version: 1 } }));
  assert.equal(res.data.result.isError, true);
  assert.match(res.data.result.content[0].text, /changed.*current version/i);
  assert.equal(res.data.result.structuredContent, undefined);
});

test('resource listing and reading remain scoped database operations', async () => {
  const calls = mockRpc(({ p_action }) => {
    if (p_action === 'authorize') return { scope: 'read' };
    if (p_action === 'list') return { documents: [{ id: ID, title: 'Private', updated_at: '2026-10-20T00:00:00Z' }], next_cursor: '100' };
    return { id: ID, markdown: '# Private page' };
  });
  const list = await request(rpc('resources/list'));
  assert.equal(list.data.result.resources[0].uri, `still://documents/${ID}`);
  assert.equal(list.data.result.nextCursor, '100');
  const read = await request(rpc('resources/read', { uri: `still://documents/${ID}` }));
  assert.deepEqual(read.data.result.contents, [{ uri: `still://documents/${ID}`, mimeType: 'text/markdown', text: '# Private page' }]);
  assert.deepEqual(calls.at(-1).p_args, { id: ID });
});

test('invalid tool arguments never reach a data operation', async () => {
  const calls = mockRpc(() => ({ scope: 'write' }));
  for (const [name, args] of [
    ['get_document', { id: '../other' }],
    ['list_documents', { limit: 101 }],
    ['search_documents', { query: ' ' }],
    ['list_documents', { cursor: '-1' }],
    ['create_document', { title: 'x'.repeat(241), markdown: '' }],
    ['create_document', { title: 'Page', markdown: '\0' }],
    ['update_document', { id: ID, title: 'Page', markdown: '', expected_version: 0 }],
    ['create_document', { title: 'Page', markdown: '', user_id: ID }],
  ]) {
    const res = await request(rpc('tools/call', { name, arguments: args }));
    assert.equal(res.data.error.code, -32602);
  }
  assert.ok(calls.every((call) => call.p_action === 'authorize'));
});

test('notifications are authenticated and return empty 202 responses', async () => {
  const calls = mockRpc();
  const res = await request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, '');
  assert.equal(calls.length, 1);
});

test('single-message JSON transport rejects malformed JSON, batches, and oversized UTF-8 bodies', async () => {
  globalThis.fetch = () => assert.fail('Invalid messages must not reach the database.');
  const malformed = await request('{"jsonrpc":');
  assert.equal(malformed.data.error.code, -32700);
  const batch = await request([rpc('ping')]);
  assert.equal(batch.data.error.code, -32600);
  const huge = await request(JSON.stringify(rpc('ping', { value: 'é'.repeat(524288) })), { stream: true });
  assert.equal(huge.statusCode, 413);
  const claimedHuge = await request(rpc('ping'), { headers: { 'content-length': '1048577' } });
  assert.equal(claimedHuge.statusCode, 413);
});

test('GET does not offer SSE, media types and protocol headers are checked', async () => {
  globalThis.fetch = () => assert.fail('Rejected transports must not reach the database.');
  const get = await request(null, { method: 'GET' });
  assert.equal(get.statusCode, 405);
  assert.equal(get.headers.allow, 'POST');
  const media = await request(rpc('ping'), { headers: { 'content-type': 'text/plain' } });
  assert.equal(media.statusCode, 415);
  const protocol = await request(rpc('ping'), { headers: { 'mcp-protocol-version': '1999-01-01' } });
  assert.equal(protocol.statusCode, 400);
});

test('unknown methods and upstream failures produce bounded errors without private details', async () => {
  mockRpc();
  const unknown = await request(rpc('unknown/method'));
  assert.equal(unknown.data.error.code, -32601);
  mockRpc(() => ({ status: 500, data: { code: 'XX000', message: 'secret database SQL password' } }));
  const upstream = await request(rpc('ping'));
  assert.equal(upstream.statusCode, 503);
  assert.doesNotMatch(upstream.body, /secret database SQL password/);
  assert.match(upstream.data.error.message, /temporarily unavailable/);
});
