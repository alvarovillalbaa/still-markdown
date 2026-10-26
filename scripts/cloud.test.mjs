import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test as nodeTest } from 'node:test';
import { CloudClient } from '../public/cloud.js';

const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PAGE = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444';
const PREFIX = 'still.auth.project.supabase.co.';
const CONFIG = { configured: true, url: 'https://project.supabase.co', publishableKey: 'sb_publishable_test' };
const json = (value, status = 200) => Response.json(value, { status });
const session = (id = A, label = 'original', expires = 3600) => ({
  access_token: `${label}-access`, refresh_token: `${label}-refresh`, token_type: 'bearer',
  expires_at: Date.now() / 1000 + expires, user: { id, email: `${id === A ? 'a' : 'b'}@example.test` },
});
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}
function environment(t, { initial, hash = '', configured = true, emailDeliveryVerified = false, handler = () => { throw new Error('Unexpected HTTP request'); } } = {}) {
  const names = ['window', 'navigator', 'location', 'history', 'fetch'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const window = new EventTarget();
  window.localStorage = memoryStorage(); window.sessionStorage = memoryStorage();
  const locks = new Map();
  const navigator = { locks: { request(name, callback) {
    const pending = (locks.get(name) || Promise.resolve()).catch(() => {}).then(callback);
    locks.set(name, pending);
    return pending.finally(() => { if (locks.get(name) === pending) locks.delete(name); });
  } } };
  const calls = []; const clients = [];
  let route = handler;
  const globals = {
    window, navigator, location: new URL(`https://still.example.test/${hash}`),
    history: { state: null, replaceState(state, title, url) {
      this.state = state; globalThis.location = new URL(url, globalThis.location);
    } },
    fetch: async (url, options = {}) => {
      const call = { url: new URL(url, 'https://still.example.test'), options,
        body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      if (call.url.pathname === '/api/config') return json(configured ? { ...CONFIG, emailDeliveryVerified } : { configured: false });
      return route(call);
    },
  };
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  function store(value) {
    window.localStorage.setItem(`${PREFIX}${value.user.id}`, JSON.stringify(value));
    window.localStorage.setItem(`${PREFIX}active`, JSON.stringify(value.user.id));
  }
  if (initial) store(initial);
  t.after(() => {
    for (const client of clients) client.dispose();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  return {
    calls, window, store,
    route(callback) { route = callback; },
    client() { const client = new CloudClient(); clients.push(client); return client; },
    storageEvent(key = `${PREFIX}active`) {
      const event = new Event('storage'); Object.defineProperty(event, 'key', { value: key }); window.dispatchEvent(event);
    },
  };
}

test('unconfigured cloud remains signed out and reports setup requirements without provider calls', async (t) => {
  const env = environment(t, { configured: false }); const client = env.client();
  assert.equal(await client.init(), null); assert.equal(client.configured, false);
  await assert.rejects(client.listDocuments(), { code: 'setup_required' });
  assert.equal(env.calls.length, 1);
});

test('signup stays gated until confirmation email delivery is verified', async (t) => {
  const env = environment(t); const client = env.client();
  await assert.rejects(client.signUp('a@example.test', 'safe-password'), { code: 'email_delivery_pending' });
  assert.equal(client.user, null);
  assert.equal(env.calls.length, 1, 'Only public configuration should be requested.');
});

test('confirmation-pending signup leaves the guest signed out without session storage or a sign-in event', async (t) => {
  const env = environment(t, { emailDeliveryVerified: true, handler(call) {
    if (call.url.pathname === '/api/health') return json({ ready: true, auth: { signupEnabled: true, emailEnabled: true, emailConfirmationRequired: true } });
    assert.equal(call.url.pathname, '/auth/v1/signup');
    assert.deepEqual(call.body, { email: 'a@example.test', password: 'safe-password' });
    assert.equal(call.options.headers.apikey, CONFIG.publishableKey);
    assert.equal(call.options.credentials, 'omit'); return json({ id: A, email: 'a@example.test', email_confirmed_at: null });
  } });
  const client = env.client(); const events = [];
  client.addEventListener('auth', ({ detail }) => events.push(detail.event));
  const result = await client.signUp(' a@example.test ', 'safe-password');
  assert.equal(result.confirmationRequired, true); assert.equal(result.session, null); assert.equal(result.user.id, A);
  assert.equal(client.getSession(), null);
  assert.equal(env.window.localStorage.getItem(`${PREFIX}active`), null);
  assert.equal(env.window.localStorage.getItem(`${PREFIX}${A}`), null);
  assert.deepEqual(events, ['SIGNED_OUT']);
  assert.equal(client.passwordRecoveryEnabled, false);
});

test('signup rejects a disabled confirmation policy before creating an account', async (t) => {
  const env = environment(t, { emailDeliveryVerified: true, handler(call) {
    assert.equal(call.url.pathname, '/api/health');
    return json({ ready: true, auth: { signupEnabled: true, emailEnabled: true, emailConfirmationRequired: false } });
  } });
  const client = env.client();
  await assert.rejects(client.signUp('a@example.test', 'safe-password'), { code: 'confirmation_policy_unavailable' });
  assert.equal(client.user, null);
  assert.equal(env.calls.some(call => call.url.pathname === '/auth/v1/signup'), false);
});

test('an unexpected immediate signup response cannot activate the cloud workspace', async (t) => {
  const env = environment(t, { emailDeliveryVerified: true, handler(call) {
    if (call.url.pathname === '/api/health') return json({ ready: true, auth: { signupEnabled: true, emailEnabled: true, emailConfirmationRequired: true } });
    assert.equal(call.url.pathname, '/auth/v1/signup'); return json(session());
  } });
  const client = env.client();
  await assert.rejects(client.signUp('a@example.test', 'safe-password'), { code: 'confirmation_policy_unavailable' });
  assert.equal(client.user, null);
  assert.equal(env.window.localStorage.getItem(`${PREFIX}active`), null);
});

test('implicit recovery callbacks scrub URL credentials before verifying and recover after offline failure', async (t) => {
  const env = environment(t, { hash: '#access_token=callback-access&refresh_token=callback-refresh&type=recovery&expires_in=3600',
    handler() { throw new TypeError('Offline'); } });
  const first = env.client();
  const pending = first.init();
  assert.equal(location.hash, '');
  await assert.rejects(pending, { code: 'network_error' });
  assert.equal(first.user, null);
  assert.ok(env.window.sessionStorage.getItem('still.auth.pending-callback'));
  env.route((call) => {
    assert.equal(call.url.pathname, '/auth/v1/user');
    assert.equal(call.options.headers.Authorization, 'Bearer callback-access'); return json(session().user);
  });
  const retry = env.client(); const events = [];
  retry.addEventListener('auth', ({ detail }) => events.push(detail.event));
  assert.equal((await retry.init()).user.id, A); assert.equal(retry.recovery, true);
  assert.deepEqual(events, ['PASSWORD_RECOVERY']);
  assert.equal(env.window.sessionStorage.getItem('still.auth.pending-callback'), null);
});

test('temporary validation outages preserve recoverable sessions and unrelated device drafts', async (t) => {
  const existing = session();
  const env = environment(t, { initial: existing, handler() { throw new TypeError('Network down'); } });
  env.window.localStorage.setItem('still.pages.guest', '[{"markdown":"keep this draft"}]');
  const client = env.client();
  assert.equal((await client.init()).access_token, existing.access_token);
  assert.equal(client.lastError.code, 'network_error');
  assert.equal(env.window.localStorage.getItem('still.pages.guest'), '[{"markdown":"keep this draft"}]');
  assert.equal(JSON.parse(env.window.localStorage.getItem(`${PREFIX}${A}`)).access_token, existing.access_token);
});

test('concurrent tabs share one refresh and both adopt the rotated refresh token', async (t) => {
  const gate = deferred(); const started = deferred(); let refreshes = 0;
  const renewed = session(A, 'rotated');
  const env = environment(t, { initial: session(A, 'expired', -20), handler(call) {
    if (call.url.pathname === '/auth/v1/token') {
      assert.equal(call.url.searchParams.get('grant_type'), 'refresh_token');
      assert.equal(call.body.refresh_token, 'expired-refresh'); refreshes++; started.resolve(); return gate.promise;
    }
    assert.equal(call.options.headers.Authorization, 'Bearer rotated-access'); return json(renewed.user);
  } });
  const one = env.client(); const two = env.client();
  const first = one.init(); const second = two.init();
  await started.promise; gate.resolve(json(renewed)); await Promise.all([first, second]);
  assert.equal(refreshes, 1); assert.equal(one.getSession().refresh_token, 'rotated-refresh');
  assert.equal(two.getSession().refresh_token, 'rotated-refresh');
});

test('a definitive invalid refresh clears that account session without deleting other account data', async (t) => {
  const env = environment(t, { initial: session(A, 'expired', -20), handler() {
    return json({ error_code: 'refresh_token_not_found', msg: 'Invalid refresh token' }, 400);
  } });
  env.window.localStorage.setItem(`${PREFIX}${B}`, JSON.stringify(session(B)));
  const client = env.client(); assert.equal(await client.init(), null);
  assert.equal(env.window.localStorage.getItem(`${PREFIX}${A}`), null);
  assert.equal(env.window.localStorage.getItem(`${PREFIX}active`), null);
  assert.equal(JSON.parse(env.window.localStorage.getItem(`${PREFIX}${B}`)).user.id, B);
});

test('late account validation cannot combine one account user with another account access token', async (t) => {
  const started = deferred(); const gate = deferred();
  const env = environment(t, { initial: session(), handler() { started.resolve(); return gate.promise; } });
  const client = env.client(); const initializing = client.init(); await started.promise;
  const next = session(B, 'account-b'); env.store(next); env.storageEvent();
  gate.resolve(json(session().user)); await initializing;
  assert.equal(client.user.id, B); assert.equal(client.getSession().access_token, next.access_token);
  assert.equal(JSON.parse(env.window.localStorage.getItem(`${PREFIX}${B}`)).user.id, B);
});

test('late document results are rejected after the active account changes', async (t) => {
  const gate = deferred(); const started = deferred();
  const env = environment(t, { initial: session(), handler(call) {
    if (call.url.pathname === '/auth/v1/user') return json(session().user);
    started.resolve(); return gate.promise;
  } });
  const client = env.client(); await client.init();
  const loading = client.listDocuments(); const rejected = assert.rejects(loading, { code: 'account_changed' });
  await started.promise; env.store(session(B, 'account-b')); env.storageEvent();
  gate.resolve(json([{ id: PAGE, markdown: 'private to a' }])); await rejected;
  assert.equal(client.user.id, B);
});

test('a delayed refresh cannot restore an account after a cross-tab account switch', async (t) => {
  const gate = deferred(); const started = deferred();
  const env = environment(t, { initial: session(), handler(call) {
    if (call.url.pathname === '/auth/v1/user') return json(session().user);
    if (call.url.pathname === '/auth/v1/token') { started.resolve(); return gate.promise; }
    throw new Error('A stale account must not send its document request');
  } });
  const client = env.client(); await client.init();
  client.session.expires_at = Date.now() / 1000 - 20; env.store(client.session);
  const loading = client.listDocuments(); const rejected = assert.rejects(loading, { code: 'account_changed' });
  await started.promise; env.store(session(B, 'account-b')); env.storageEvent();
  gate.resolve(json(session(A, 'rotated-a'))); await rejected;
  assert.equal(client.user.id, B); assert.equal(client.session.access_token, 'account-b-access');
});

test('newer sign-in intent wins when an older sign-in response arrives late', async (t) => {
  const gate = deferred(); const started = deferred();
  const env = environment(t, { handler(call) {
    if (call.body.email === 'a@example.test') { started.resolve(); return gate.promise; }
    return json(session(B, 'newer-b'));
  } });
  const client = env.client(); await client.init();
  const older = client.signIn('a@example.test', 'safe-password');
  const stale = assert.rejects(older, { code: 'account_changed' });
  await started.promise; await client.signIn('b@example.test', 'safe-password');
  gate.resolve(json(session(A, 'older-a'))); await stale;
  assert.equal(client.user.id, B); assert.equal(JSON.parse(env.window.localStorage.getItem(`${PREFIX}active`)), B);
});

test('a cross-tab account change invalidates an older in-flight sign-in', async (t) => {
  const gate = deferred(); const started = deferred();
  const env = environment(t, { handler() { started.resolve(); return gate.promise; } });
  const client = env.client(); await client.init();
  const older = client.signIn('a@example.test', 'safe-password');
  const stale = assert.rejects(older, { code: 'account_changed' });
  await started.promise; env.store(session(B, 'tab-b')); env.storageEvent();
  gate.resolve(json(session(A, 'late-a'))); await stale;
  assert.equal(client.user.id, B); assert.equal(client.session.access_token, 'tab-b-access');
});

test('a local sign-out cancels an older sign-in even before that login established a session', async (t) => {
  const gate = deferred(); const started = deferred();
  const env = environment(t, { handler() { started.resolve(); return gate.promise; } });
  const client = env.client(); await client.init();
  const older = client.signIn('a@example.test', 'safe-password');
  const stale = assert.rejects(older, { code: 'account_changed' });
  await started.promise; await client.signOut(); gate.resolve(json(session(A, 'late-a'))); await stale;
  assert.equal(client.user, null); assert.equal(env.window.localStorage.getItem(`${PREFIX}active`), null);
});

test('token creation hashes the entire random token and requests only public metadata fields', async (t) => {
  let inserted; const metadata = { id: TOKEN, user_id: A, name: 'Cursor', scope: 'read',
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString() };
  const env = environment(t, { initial: session(), handler(call) {
    if (call.url.pathname === '/auth/v1/user') return json(session().user);
    assert.equal(call.url.pathname, '/rest/v1/mcp_tokens');
    assert.equal(call.url.searchParams.get('select'), 'id,user_id,name,scope,expires_at,created_at');
    assert.ok(!call.url.searchParams.get('select').includes('token_hash'));
    if (call.options.method === 'POST') { inserted = call.body; return json([metadata]); }
    return json([metadata]);
  } });
  const client = env.client(); await client.init(); const result = await client.createToken(' Cursor ');
  assert.match(result.token, /^still_[A-Za-z0-9_-]{43}$/);
  assert.equal(inserted.token_hash, createHash('sha256').update(result.token).digest('hex'));
  assert.equal(inserted.user_id, A); assert.equal(inserted.scope, 'read');
  assert.equal(JSON.stringify(inserted).includes(result.token), false);
  assert.deepEqual(result.record, metadata); assert.deepEqual(await client.listTokens(), [metadata]);
  assert.equal(JSON.stringify([...env.window.localStorage.values]).includes(result.token), false);
});

test('late token creation results do not expose an old account secret to a new account', async (t) => {
  const started = deferred(); const gate = deferred();
  const env = environment(t, { initial: session(), handler(call) {
    if (call.url.pathname === '/auth/v1/user') return json(session().user);
    started.resolve(); return gate.promise;
  } });
  const client = env.client(); await client.init();
  const creating = client.createToken('Private A token'); const rejected = assert.rejects(creating, { code: 'account_changed' });
  await started.promise; env.store(session(B, 'account-b')); env.storageEvent();
  gate.resolve(json([{ id: TOKEN, user_id: A, name: 'Private A token', scope: 'read' }])); await rejected;
  assert.equal(client.user.id, B);
});

test('conflicting saves preserve the server version contract and report a recoverable conflict', async (t) => {
  const env = environment(t, { initial: session(), handler(call) {
    if (call.url.pathname === '/auth/v1/user') return json(session().user);
    assert.equal(call.url.pathname, '/rest/v1/rpc/save_document');
    assert.deepEqual(call.body, { p_id: PAGE, p_title: 'My page', p_markdown: 'Keep the draft', p_expected_version: 7 });
    return json({ code: '40001', message: 'document_version_conflict' }, 409);
  } });
  const client = env.client(); await client.init();
  await assert.rejects(client.saveDocument({ id: PAGE, title: 'My page', markdown: 'Keep the draft', version: 7 }), {
    code: 'document_version_conflict', status: 409,
  });
  assert.equal(client.user.id, A);
});

test('logout network failure preserves the session and confirmed logout removes only auth storage', async (t) => {
  let offline = true;
  const env = environment(t, { initial: session(), handler(call) {
    if (call.url.pathname === '/auth/v1/user') return json(session().user);
    assert.equal(call.url.pathname, '/auth/v1/logout'); assert.equal(call.url.searchParams.get('scope'), 'local');
    if (offline) throw new TypeError('Offline'); return new Response(null, { status: 204 });
  } });
  env.window.localStorage.setItem(`still.pages.${A}`, '[{"markdown":"device copy"}]');
  const client = env.client(); await client.init();
  await assert.rejects(client.signOut(), { code: 'network_error' }); assert.equal(client.user.id, A);
  offline = false; await client.signOut(); assert.equal(client.user, null);
  assert.equal(env.window.localStorage.getItem(`${PREFIX}${A}`), null);
  assert.equal(env.window.localStorage.getItem(`still.pages.${A}`), '[{"markdown":"device copy"}]');
});

test('recovery and password updates use the intended Auth endpoints and session authorization', async (t) => {
  const env = environment(t, { initial: session(), handler(call) {
    if (call.url.pathname === '/auth/v1/recover') {
      assert.deepEqual(call.body, { email: 'a@example.test' });
      assert.equal(call.url.searchParams.get('redirect_to'), 'https://still.example.test/'); return json({});
    }
    assert.equal(call.url.pathname, '/auth/v1/user');
    if (call.options.method === 'PUT') {
      assert.deepEqual(call.body, { password: 'replacement-password' });
      assert.equal(call.options.headers.Authorization, 'Bearer original-access');
    }
    return json(session().user);
  } });
  const client = env.client(); await client.init(); await client.recover(' a@example.test ');
  client.recovery = true;
  const events = []; client.addEventListener('auth', ({ detail }) => events.push(detail.event));
  assert.equal((await client.updatePassword('replacement-password')).id, A);
  assert.equal(client.recovery, false); assert.deepEqual(events, ['USER_UPDATED']);
});

test('upstream errors redact credentials and remain bounded for display', async (t) => {
  const token = `still_${'a'.repeat(43)}`; const jwt = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
  const env = environment(t, { handler() {
    return json({ error_code: 'invalid_credentials', msg: `Invalid token ${token} and ${jwt}` }, 400);
  } });
  const client = env.client();
  await assert.rejects(client.signIn('a@example.test', 'safe-password'), (error) => {
    assert.equal(error.code, 'invalid_credentials'); assert.ok(error.message.includes('[redacted]'));
    assert.ok(error.message.length <= 240); assert.ok(!error.message.includes(token));
    assert.ok(!error.message.includes(jwt)); return true;
  });
});
