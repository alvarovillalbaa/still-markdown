#!/usr/bin/env node
import { once } from 'node:events';

const MAX_LINE = 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
let endpoint;
try {
  endpoint = new URL(process.env.STILL_MCP_URL || '');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
  if (!/^still_[A-Za-z0-9_-]{43}$/.test(process.env.STILL_MCP_TOKEN || '')) throw new Error();
} catch {
  process.stderr.write('Set STILL_MCP_URL to your HTTPS /api/mcp endpoint and STILL_MCP_TOKEN to a Still connection token. Node 22 or newer is required.\n');
  process.exitCode = 1;
}

let protocolVersion;
async function output(value) {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) await once(process.stdout, 'drain');
}
function error(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function responseJson(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE) throw new Error('Response is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(utf8.decode(Buffer.concat(chunks)));
}

async function relay(line) {
  let message;
  try { message = JSON.parse(line); }
  catch { return output(error(null, -32700, 'Parse error.')); }
  const isObject = object(message);
  const hasId = isObject && Object.hasOwn(message, 'id');
  const validId = !hasId || typeof message.id === 'string' || (typeof message.id === 'number' && Number.isSafeInteger(message.id));
  if (!isObject || message.jsonrpc !== '2.0' || !validId || typeof message.method !== 'string'
    || !message.method || (message.params !== undefined && !object(message.params))) {
    return output(error(null, -32600, 'Invalid JSON-RPC request.'));
  }
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STILL_MCP_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
      },
      body: line,
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (response.status === 202 || response.status === 204) {
      if (hasId) await output(error(message.id, -32000, 'The server returned no response.'));
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('Expected JSON response.');
    const result = await responseJson(response);
    if (!hasId) {
      if (!response.ok) process.stderr.write(`Still rejected a notification (HTTP ${response.status}).\n`);
      return;
    }
    const hasResult = object(result) && Object.hasOwn(result, 'result');
    const hasError = object(result) && Object.hasOwn(result, 'error');
    const validError = !hasError || (object(result.error) && Number.isSafeInteger(result.error.code) && typeof result.error.message === 'string');
    if (!object(result) || result.jsonrpc !== '2.0' || result.id !== message.id || hasResult === hasError || !validError) {
      await output(error(message.id, -32000, `Still returned an invalid response (HTTP ${response.status}).`));
      return;
    }
    if (!response.ok && !hasError) {
      await output(error(message.id, -32000, `Still rejected the request (HTTP ${response.status}).`));
      return;
    }
    if (message.method === 'initialize' && result.result?.protocolVersion) protocolVersion = result.result.protocolVersion;
    if (hasError) {
      const safeError = JSON.parse(JSON.stringify(result.error).replaceAll(process.env.STILL_MCP_TOKEN, '[redacted]'));
      await output({ jsonrpc: '2.0', id: message.id, error: safeError });
    } else await output(result);
  } catch {
    if (hasId) await output(error(message.id, -32000, 'Could not reach Still. Check the endpoint, token, and connection.'));
    else process.stderr.write('Could not deliver a notification to Still.\n');
  }
}

if (!process.exitCode) {
  let pending = Buffer.alloc(0);
  let discarding = false;
  const consume = async (bytes) => {
    if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1);
    if (bytes.byteLength > MAX_LINE) return output(error(null, -32600, 'Request exceeds 1 MiB.'));
    let line;
    try { line = utf8.decode(bytes); }
    catch { return output(error(null, -32700, 'Parse error.')); }
    if (line.trim()) await relay(line);
  };
  try {
    for await (const chunk of process.stdin) {
      pending = Buffer.concat([pending, chunk]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (discarding) { discarding = false; continue; }
        await consume(line);
      }
      // Permit one possible CR while waiting for a CRLF delimiter.
      if (pending.byteLength > MAX_LINE + 1) {
        if (!discarding) await output(error(null, -32600, 'Request exceeds 1 MiB.'));
        pending = Buffer.alloc(0);
        discarding = true;
      }
    }
    if (!discarding && pending.byteLength) await consume(pending);
  } catch {
    process.stderr.write('Still bridge stopped because its input or output stream closed.\n');
    process.exitCode = 1;
  }
}
