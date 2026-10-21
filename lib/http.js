export const MAX_REQUEST_BYTES = 1024 * 1024;

export function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}

export function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (typeof origin !== 'string') return false;
  try {
    const incoming = new URL(origin);
    if (incoming.origin !== origin || incoming.username || incoming.password) return false;
    const host = req.headers.host;
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const allowed = new Set();
    if (host && ['http', 'https'].includes(proto)) allowed.add(new URL(`${proto}://${host}`).origin);
    if (process.env.APP_ORIGIN) allowed.add(new URL(process.env.APP_ORIGIN).origin);
    return allowed.has(origin);
  } catch { return false; }
}

export async function readJson(req) {
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(String(length)) || Number(length) > MAX_REQUEST_BYTES)) {
    throw Object.assign(new Error('Request exceeds 1 MiB.'), { status: 413 });
  }
  if (req.body !== undefined) {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    const serialized = typeof body === 'string' ? body : JSON.stringify(body);
    if (Buffer.byteLength(serialized || '') > MAX_REQUEST_BYTES) {
      throw Object.assign(new Error('Request exceeds 1 MiB.'), { status: 413 });
    }
    return typeof body === 'string' ? JSON.parse(body) : body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('Request exceeds 1 MiB.'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
