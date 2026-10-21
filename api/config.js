import { json } from '../lib/http.js';
import { publicConfig } from '../lib/supabase.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'Method not allowed.' });
  }
  return json(res, 200, { ...publicConfig(), passwordRecoveryEnabled: process.env.PASSWORD_RECOVERY_ENABLED === 'true', revision: process.env.VERCEL_GIT_COMMIT_SHA || 'local' });
}
