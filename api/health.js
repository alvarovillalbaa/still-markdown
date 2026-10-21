import { json } from '../lib/http.js';
import { publicConfig } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return json(res, 405, { error: 'Method not allowed.' }); }
  const config = publicConfig();
  if (!config.configured) return json(res, 503, { application: 'still', ready: false, reason: 'configuration_missing' });
  try {
    const response = await fetch(`${config.url}/auth/v1/settings`, {
      headers: { apikey: config.publishableKey }, redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    const settings = await response.json();
    if (!response.ok) return json(res, 503, { application: 'still', ready: false, upstreamStatus: response.status,
      reason: String(settings.code || settings.message || settings.msg || 'auth_unavailable').replace(/sb_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 160) });
    return json(res, 200, { application: 'still', ready: true, revision: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
      auth: { emailEnabled: settings.external?.email === true, signupEnabled: settings.disable_signup !== true, emailConfirmationRequired: settings.mailer_autoconfirm !== true } });
  } catch { return json(res, 503, { application: 'still', ready: false, reason: 'auth_unreachable' }); }
}
