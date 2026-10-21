export class ServiceError extends Error {
  constructor(message, status = 503, code = 'unavailable') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function publicConfig(env = { ...project, ...process.env }) {
  try {
    const url = new URL(env.SUPABASE_URL || '');
    const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || '';
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
        url.username || url.password || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
      throw new Error('Invalid public configuration');
    }
    return { configured: true, url: url.origin, publishableKey };
  } catch {
    return { configured: false, url: '', publishableKey: '' };
  }
}

export async function dispatch(tokenHash, action, args = {}) {
  const config = publicConfig();
  if (!config.configured) throw new ServiceError('Cloud storage is not configured.');
  let response;
  try {
    response = await fetch(`${config.url}/rest/v1/rpc/mcp_dispatch`, {
      method: 'POST',
      headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token_hash: tokenHash, p_action: action, p_args: args }),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
  } catch {
    throw new ServiceError('Cloud storage is temporarily unavailable.');
  }
  let data;
  try { data = await response.json(); } catch { throw new ServiceError('Cloud storage returned an invalid response.'); }
  if (response.ok) return data;
  const errors = {
    '28000': ['The connection token is invalid, expired, or revoked.', 401, 'unauthorized'],
    '42501': ['This connection has read access only.', 403, 'forbidden'],
    P0002: ['The page was not found.', 404, 'not_found'],
    '40001': ['The page changed. Read its current version before saving again.', 409, 'conflict'],
    '23505': ['A page with this ID already exists.', 409, 'conflict'],
    '22023': ['Invalid page arguments.', 400, 'invalid_params'],
    '22P02': ['Invalid page arguments.', 400, 'invalid_params'],
    '22P05': ['The page contains unsupported text characters.', 400, 'invalid_params'],
    '23514': ['The page exceeds its allowed limits.', 400, 'invalid_params'],
  };
  const detail = errors[data?.code];
  if (detail) throw new ServiceError(...detail);
  throw new ServiceError('Cloud storage is temporarily unavailable.');
}
import { project } from './project.js';

