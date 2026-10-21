import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test as nodeTest } from 'node:test';

const test = (name, run) => nodeTest(`mocked HTTP / actual stdio: ${name}`, { timeout: 15_000 }, run);
const SCRIPT = fileURLToPath(new URL('./mcp-stdio.mjs', import.meta.url));
const TOKEN = `still_${'a'.repeat(43)}`;
const MAX_LINE = 1024 * 1024;
const fixtures = new Map();
const rpc = (id, method = 'ping', params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const line = (message) => `${JSON.stringify(message)}\n`;
const reply = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
};

async function realServer(t, handler) {
  const calls = [];
  const instance = createServer(async (req, res) => {
    res.on('error', () => {});
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const call = { headers: req.headers, method: req.method, url: req.url, body, message: JSON.parse(body) };
      calls.push(call); await handler(call, res, req);
    } catch (error) {
      if (!res.headersSent) reply(res, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Fixture failed.' } }, 500);
      else res.destroy(error);
    }
  });
  instance.listen(0, '127.0.0.1');
  try { await once(instance, 'listening'); }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.skip(`Loopback HTTP listeners are unavailable in this sandbox (${error.code}).`); return null;
  }
  t.after(async () => {
    instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve));
  });
  return { calls, url: `http://127.0.0.1:${instance.address().port}/api/mcp` };
}

// IPC replaces fetch only inside the test child. The production bridge is imported unchanged.
async function server(t, handler) {
  const fixture = { calls: [], handler, url: `http://127.0.0.1:${19000 + fixtures.size}/api/mcp` };
  fixtures.set(fixture.url, fixture); t.after(() => fixtures.delete(fixture.url)); return fixture;
}
async function mockedFetch(url, options) {
  const fixture = fixtures.get(url);
  if (!fixture) throw new Error('Unknown fixture endpoint');
  const call = { headers: options.headers, method: options.method, url: new URL(url).pathname,
    body: options.body, message: JSON.parse(options.body) };
  fixture.calls.push(call);
  let failure;
  const response = { status: 200, headers: {}, body: '',
    on() {}, writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(value = '') { this.body = String(value); }, destroy() { failure = new Error('Disconnected'); },
  };
  await fixture.handler(call, response, { socket: { destroy() { failure = new Error('Disconnected'); } } });
  if (failure) throw failure;
  if (response.status >= 300 && response.status < 400 && response.headers.Location) {
    if (options.redirect === 'error') throw new Error('Redirect rejected');
    return mockedFetch(response.headers.Location, options);
  }
  return response;
}

async function runBridge(t, endpoint, chunks, { token = TOKEN, delay = 0 } = {}) {
  const mocked = fixtures.has(endpoint);
  const bootstrap = `
    let next = 0;
    const pending = new Map();
    process.on('message', (message) => {
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id);
      if (message.failure) request.reject(new Error('Mock network failure'));
      else request.resolve(new Response([202, 204, 304].includes(message.status) ? null : message.body,
        { status: message.status, headers: message.headers }));
    });
    globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
      const id = ++next; pending.set(id, { resolve, reject });
      process.send({ id, url: String(url), options: { method: options.method, body: options.body,
        headers: Object.fromEntries(new Headers(options.headers)), redirect: options.redirect } });
    });
    await import(${JSON.stringify(new URL('./mcp-stdio.mjs', import.meta.url).href)});
    process.disconnect();
  `;
  const child = spawn(process.execPath, mocked ? ['--input-type=module', '--eval', bootstrap] : [SCRIPT], {
    env: { STILL_MCP_URL: endpoint, STILL_MCP_TOKEN: token }, stdio: mocked ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (mocked) child.on('message', async (message) => {
    try {
      const response = await mockedFetch(message.url, message.options);
      if (child.connected) child.send({ id: message.id, ...response });
    } catch {
      if (child.connected) child.send({ id: message.id, failure: true });
    }
  });
  const closed = once(child, 'close');
  child.stdin.on('error', () => {});
  for (const chunk of chunks) {
    if (!child.stdin.write(chunk)) await Promise.race([once(child.stdin, 'drain'), closed]);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  child.stdin.end();
  const [code, signal] = await closed;
  const messages = stdout.trim() ? stdout.trim().split('\n').map((value) => JSON.parse(value)) : [];
  return { code, signal, stdout, stderr, messages };
}

test('real stdio initialization, notifications and requests preserve ids and negotiated HTTP headers', async (t) => {
  const fixture = await server(t, (call, res) => {
    if (!Object.hasOwn(call.message, 'id')) { res.writeHead(202); res.end(); return; }
    reply(res, { jsonrpc: '2.0', id: call.message.id,
      result: call.message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } : {} });
  });
  const result = await runBridge(t, fixture.url, [
    line(rpc('init', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })),
    line({ jsonrpc: '2.0', method: 'notifications/initialized' }), line(rpc(0)), line(rpc('')),
  ]);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(result.messages.map((message) => message.id), ['init', 0, '']);
  assert.equal(fixture.calls.length, 4);
  for (const call of fixture.calls) {
    assert.equal(call.method, 'POST'); assert.equal(call.url, '/api/mcp');
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(call.headers.accept, /application\/json/); assert.match(call.headers.accept, /text\/event-stream/);
    assert.match(call.headers['content-type'], /^application\/json/);
    assert.equal(call.body.includes(TOKEN), false);
  }
  assert.equal(fixture.calls[0].headers['mcp-protocol-version'], undefined);
  assert.ok(fixture.calls.slice(1).every((call) => call.headers['mcp-protocol-version'] === '2025-11-25'));
  assert.equal(result.stdout.includes(TOKEN), false); assert.equal(result.stderr.includes(TOKEN), false);
});

test('split Unicode bytes, CRLF, multiple lines, and a final line without newline survive actual pipes', async (t) => {
  const fixture = await server(t, (call, res) => reply(res, { jsonrpc: '2.0', id: call.message.id, result: call.message.params }));
  const first = Buffer.from(line(rpc('unicode', 'ping', { text: 'café 漢字 🙂' })).replace(/\n$/, '\r\n'));
  const emoji = first.indexOf(Buffer.from('🙂'));
  const result = await runBridge(t, fixture.url, [first.subarray(0, emoji + 1), first.subarray(emoji + 1, emoji + 3),
    first.subarray(emoji + 3), Buffer.from(`\n  \n${JSON.stringify(rpc(2, 'ping', { text: 'last' }))}`)], { delay: 8 });
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(result.messages.map((message) => message.result.text), ['café 漢字 🙂', 'last']);
});

test('malformed JSON, batch messages and invalid MCP ids stay local while later valid input still works', async (t) => {
  const fixture = await server(t, (call, res) => reply(res, { jsonrpc: '2.0', id: call.message.id, result: {} }));
  const invalid = [null, [], { jsonrpc: '1.0', id: 1, method: 'ping' }, rpc(null), rpc(1.5), rpc({ nested: 1 }), rpc(true)];
  const result = await runBridge(t, fixture.url, ['{"jsonrpc":\n', ...invalid.map(line), line(rpc('after'))]);
  assert.equal(result.messages[0].error.code, -32700);
  assert.ok(result.messages.slice(1, -1).every((message) => message.id === null && message.error.code === -32600));
  assert.deepEqual(result.messages.at(-1), { jsonrpc: '2.0', id: 'after', result: {} });
  assert.deepEqual(fixture.calls.map((call) => call.message.id), ['after']);
});

test('empty methods and malformed named params are rejected before an HTTP request', async (t) => {
  const fixture = await server(t, (call, res) => reply(res, { jsonrpc: '2.0', id: call.message.id, result: {} }));
  const result = await runBridge(t, fixture.url, [line(rpc(1, '')), line(rpc(2, 'ping', null)),
    line(rpc(3, 'ping', ['positional'])), line(rpc(4, 'ping', 'invalid'))]);
  assert.equal(result.messages.length, 4);
  assert.ok(result.messages.every((message) => message.error?.code === -32600));
  assert.equal(fixture.calls.length, 0);
});

test('oversized UTF-8 input is discarded once and the next message is accepted', async (t) => {
  const fixture = await server(t, (call, res) => reply(res, { jsonrpc: '2.0', id: call.message.id, result: {} }));
  const oversized = Buffer.from(line(rpc(1, 'ping', { text: 'é'.repeat(MAX_LINE / 2) })));
  const chunks = []; for (let offset = 0; offset < oversized.length; offset += 32768) chunks.push(oversized.subarray(offset, offset + 32768));
  chunks.push(Buffer.from(line(rpc(2))));
  const result = await runBridge(t, fixture.url, chunks);
  assert.equal(result.messages.length, 2); assert.equal(result.messages[0].error.code, -32600);
  assert.match(result.messages[0].error.message, /1 MiB/); assert.equal(result.messages[1].id, 2);
  assert.deepEqual(fixture.calls.map((call) => call.message.id), [2]);
});

test('invalid UTF-8 is rejected instead of silently replacing bytes in page content', async (t) => {
  const fixture = await server(t, (call, res) => reply(res, { jsonrpc: '2.0', id: call.message.id, result: {} }));
  const corrupted = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"text":"'),
    Buffer.from([0xff]), Buffer.from('"}}\n'), Buffer.from(line(rpc(2)))]);
  const result = await runBridge(t, fixture.url, [corrupted]);
  assert.equal(result.messages[0].error?.code, -32700); assert.equal(result.messages[1].id, 2);
  assert.deepEqual(fixture.calls.map((call) => call.message.id), [2]);
});

test('HTTP errors and JSON-RPC errors remain errors', async (t) => {
  const fixture = await server(t, (call, res) => {
    if (call.message.id === 1) return reply(res, { jsonrpc: '2.0', id: 1, result: { incorrectSuccess: true } }, 503);
    if (call.message.id === 2) return reply(res, { jsonrpc: '2.0', id: 2, error: { code: -32001,
      message: 'Rejected connection token.' } }, 401);
    reply(res, { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'Method not found.' } });
  });
  const result = await runBridge(t, fixture.url, [line(rpc(1)), line(rpc(2)), line(rpc(3))]);
  assert.ok(result.messages.every((message) => message.error && !Object.hasOwn(message, 'result')));
  assert.equal(result.messages[0].error.code, -32000); assert.equal(result.messages[1].error.code, -32001);
  assert.equal(result.messages[2].error.code, -32601);
  assert.equal(result.stdout.includes(TOKEN), false); assert.equal(result.stderr.includes(TOKEN), false);
});

test('an authorization secret echoed in a valid upstream error is redacted on stdio', async (t) => {
  const fixture = await server(t, (call, res) => reply(res, { jsonrpc: '2.0', id: call.message.id,
    error: { code: -32001, message: `Rejected Bearer ${TOKEN}`, data: { echoed: TOKEN } } }, 401));
  const result = await runBridge(t, fixture.url, [line(rpc('private-error'))]);
  assert.equal(result.messages[0].id, 'private-error'); assert.equal(result.messages[0].error.code, -32001);
  assert.equal(result.stdout.includes(TOKEN), false); assert.equal(result.stderr.includes(TOKEN), false);
});

test('invalid server response envelopes and error objects never escape as invalid stdio MCP messages', async (t) => {
  const responses = [
    { jsonrpc: '2.0', id: 99, result: {} },
    { jsonrpc: '2.0', result: {} },
    { jsonrpc: '2.0', id: 2, result: {}, error: { code: -32000, message: 'both' } },
    { jsonrpc: '2.0', id: 3, error: 'invalid' },
    { jsonrpc: '2.0', id: 4, error: { code: 'not a number', message: 'bad' } },
    { jsonrpc: '2.0', id: 5, error: { code: -32000, message: null } },
    { jsonrpc: '2.0', id: 6, error: null },
    { jsonrpc: '1.0', id: 7, result: {} },
  ];
  const fixture = await server(t, (call, res) => reply(res, responses[call.message.id]));
  const result = await runBridge(t, fixture.url, responses.map((_, id) => line(rpc(id))));
  assert.equal(result.messages.length, responses.length);
  result.messages.forEach((message, id) => {
    assert.equal(message.id, id); assert.equal(message.jsonrpc, '2.0');
    assert.equal(message.error?.code, -32000); assert.equal(typeof message.error.message, 'string');
    assert.equal(Object.hasOwn(message, 'result'), false);
  });
});

test('missing responses, malformed JSON, unexpected media and failed connections return bounded diagnostics', async (t) => {
  const fixture = await server(t, (call, res, req) => {
    if (call.message.id === 1) { res.writeHead(202); res.end(); }
    else if (call.message.id === 2) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{broken'); }
    else if (call.message.id === 3) { res.writeHead(500, { 'Content-Type': 'text/html' }); res.end(`<h1>${TOKEN}</h1>`); }
    else req.socket.destroy();
  });
  const result = await runBridge(t, fixture.url, [1, 2, 3, 4].map((id) => line(rpc(id))));
  assert.equal(result.messages.length, 4);
  assert.ok(result.messages.every((message) => message.error?.code === -32000));
  assert.ok(result.stdout.length < 2048); assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(result.stderr.includes(TOKEN), false);
});

test('notifications never produce stdout responses even when HTTP rejects them', async (t) => {
  const fixture = await server(t, (call, res) => reply(res, { jsonrpc: '2.0', id: null,
    error: { code: -32001, message: `Private detail ${TOKEN}` } }, 401));
  const result = await runBridge(t, fixture.url, [line({ jsonrpc: '2.0', method: 'notifications/initialized' })]);
  assert.equal(result.stdout, ''); assert.match(result.stderr, /HTTP 401/);
  assert.equal(result.stderr.includes(TOKEN), false);
});

test('response size bounds prevent a server from flooding the stdio client', async (t) => {
  const fixture = await server(t, (call, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.message.id, result: { text: 'x'.repeat(8 * 1024 * 1024) } }));
  });
  const result = await runBridge(t, fixture.url, [line(rpc('large-response'))]);
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0].id, 'large-response');
  assert.equal(result.messages[0].error?.code, -32000); assert.ok(result.stdout.length < 512);
});

test('redirects are rejected without forwarding credentials to the redirect destination', async (t) => {
  const target = await server(t, (call, res) => reply(res, { jsonrpc: '2.0', id: call.message.id, result: {} }));
  const fixture = await server(t, (call, res) => { res.writeHead(307, { Location: target.url }); res.end(); });
  const result = await runBridge(t, fixture.url, [line(rpc('redirect'))]);
  assert.equal(fixture.calls.length, 1); assert.equal(target.calls.length, 0);
  assert.equal(result.messages[0].error?.code, -32000); assert.equal(result.stdout.includes(TOKEN), false);
});

test('HTTPS and token guards reject insecure or ambiguous configuration without printing secrets', async (t) => {
  for (const endpoint of ['http://example.com/api/mcp', 'http://localhost.attacker.test/api/mcp',
    'https://user:private@example.com/api/mcp', 'https://example.com/api/mcp#secret', 'not a url']) {
    const result = await runBridge(t, endpoint, []);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /HTTPS/);
    assert.equal(result.stderr.includes(TOKEN), false); assert.equal(result.stderr.includes('private'), false);
  }
  const invalidToken = await runBridge(t, 'https://example.com/api/mcp', [], { token: 'not-a-valid-secret-token' });
  assert.equal(invalidToken.code, 1); assert.equal(invalidToken.stdout, '');
  assert.equal(invalidToken.stderr.includes('not-a-valid-secret-token'), false);
});

nodeTest('real HTTP / actual stdio: loopback requests carry authentication and notifications stay silent', { timeout: 15_000 }, async (t) => {
  const fixture = await realServer(t, (call, res) => {
    if (!Object.hasOwn(call.message, 'id')) { res.writeHead(202); res.end(); return; }
    reply(res, { jsonrpc: '2.0', id: call.message.id, result: { text: call.message.params?.text } });
  });
  if (!fixture) return;
  const result = await runBridge(t, fixture.url, [line(rpc('http', 'ping', { text: 'Real HTTP café 🙂' })),
    line({ jsonrpc: '2.0', method: 'notifications/initialized' })]);
  assert.equal(result.code, 0); assert.equal(result.stderr, ''); assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].result.text, 'Real HTTP café 🙂'); assert.equal(fixture.calls.length, 2);
  assert.ok(fixture.calls.every((call) => call.headers.authorization === `Bearer ${TOKEN}`));
  assert.equal(result.stdout.includes(TOKEN), false);
});

nodeTest('real HTTP / actual stdio: native fetch rejects redirects without contacting their destination', { timeout: 15_000 }, async (t) => {
  const target = await realServer(t, (call, res) => reply(res, { jsonrpc: '2.0', id: call.message.id, result: {} }));
  if (!target) return;
  const fixture = await realServer(t, (call, res) => { res.writeHead(307, { Location: target.url }); res.end(); });
  if (!fixture) return;
  const result = await runBridge(t, fixture.url, [line(rpc('redirect'))]);
  assert.equal(fixture.calls.length, 1); assert.equal(target.calls.length, 0);
  assert.equal(result.messages[0].error?.code, -32000); assert.equal(result.stdout.includes(TOKEN), false);
});
