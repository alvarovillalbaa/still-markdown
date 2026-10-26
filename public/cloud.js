const DOCUMENT_FIELDS = 'id,user_id,title,markdown,version,created_at,updated_at';
const TOKEN_FIELDS = 'id,user_id,name,scope,expires_at,created_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFRESH_MARGIN = 60_000;

export class CloudError extends Error {
  constructor(message, { status = 0, code = 'cloud_error' } = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
  }
}

function readJSON(storage, key) {
  try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; }
}

function browserStorage(name) {
  try { return window[name]; } catch { return null; }
}

function validSession(session) {
  return session && typeof session.access_token === 'string' && session.access_token
    && typeof session.refresh_token === 'string' && session.refresh_token
    && UUID.test(session.user?.id) && Number.isFinite(session.expires_at);
}

function safeMessage(value) {
  return String(value || '').replace(/[\u0000-\u001f<>]/g, ' ')
    .replace(/still_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .trim().slice(0, 240);
}

async function responseError(response) {
  let text = '';
  // Auth and database errors can include upstream HTML. Read only a small body.
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (text.length < 4096) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value.subarray(0, 4096 - text.length), { stream: true });
      }
    } catch { /* A broken error stream still gets a readable fallback. */ }
    finally { await reader.cancel().catch(() => {}); }
  } else text = (await response.text()).slice(0, 4096);
  let body = {};
  try { body = JSON.parse(text); } catch { /* Use a plain fallback for HTML. */ }
  const code = body.code || body.error_code || body.error || 'cloud_error';
  if (code === '40001' || body.message === 'document_version_conflict') {
    return new CloudError('This page changed elsewhere. Your draft is safe; reload the cloud copy before saving again.', {
      status: 409, code: 'document_version_conflict',
    });
  }
  const fallback = response.status === 429 ? 'Too many requests. Please wait a moment and try again.'
    : response.status >= 500 ? 'Cloud storage is temporarily unavailable. Your local draft is safe.'
      : response.status === 401 ? 'Your session has expired. Please sign in again.'
        : 'The cloud request could not be completed.';
  return new CloudError(safeMessage(body.msg || body.message || body.error_description) || fallback, {
    status: response.status, code: String(code),
  });
}

/** First-party Supabase HTTP client. Draft storage remains the app's responsibility. */
export class CloudClient extends EventTarget {
  constructor() {
    super();
    this.configured = false;
    this.emailDeliveryVerified = false;
    this.passwordRecoveryEnabled = false;
    this.session = null;
    this.recovery = false;
    this.lastError = null;
    this._config = null;
    this._initPromise = null;
    this._refreshPromise = null;
    this._refreshTimer = null;
    this._disposed = false;
    this._storage = browserStorage('localStorage');
    this._callbackStorage = browserStorage('sessionStorage');
    this._pendingKey = 'still.auth.pending-callback';
    this._sessionPersisted = false;
    this._generation = 0;
    this._authAttempt = 0;
    this._onStorage = (event) => {
      if (!this._storagePrefix || !event.key?.startsWith(this._storagePrefix)) return;
      const stored = this._storedSession();
      if (stored?.user.id !== this.user?.id) this._authAttempt += 1;
      this._acceptSession(stored, 'SIGNED_IN', false);
    };
    window.addEventListener('storage', this._onStorage);
  }

  get user() { return this.session?.user || null; }
  getSession() { return this.session; }

  init() {
    if (!this._initPromise) {
      this._initPromise = this._initialize().catch((error) => {
        this._initPromise = null;
        throw error;
      });
    }
    return this._initPromise;
  }

  async _initialize() {
    const callback = this._takeCallback() || readJSON(this._callbackStorage, this._pendingKey);
    this._config = await this._fetchJSON('/api/config');
    if (!this._config?.configured) return null;
    let project;
    try { project = new URL(this._config.url); } catch {
      throw new CloudError('Cloud storage has an invalid project URL.');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(project.hostname);
    if ((project.protocol !== 'https:' && !(local && project.protocol === 'http:'))
      || project.username || project.password || !this._config.publishableKey
      || String(this._config.publishableKey).startsWith('sb_secret_')) {
      throw new CloudError('Cloud storage is not configured correctly.');
    }
    this._config.url = project.origin;
    this.configured = true;
    this.emailDeliveryVerified = this._config.emailDeliveryVerified === true;
    this.passwordRecoveryEnabled = this._config.passwordRecoveryEnabled === true;
    this._storagePrefix = `still.auth.${project.host}.`;
    this._activeKey = `${this._storagePrefix}active`;
    const pending = callback;
    if (pending?.access_token && pending.refresh_token) {
      // Keep a callback recoverable after an offline redirect, but scrub its URL immediately.
      try { this._callbackStorage?.setItem(this._pendingKey, JSON.stringify(pending)); } catch { /* Memory still works. */ }
      try {
        let session = pending;
        let user;
        try { user = await this._request('/auth/v1/user', { token: session.access_token }); }
        catch (error) {
          if (error.status !== 401 && error.status !== 403) throw error;
          session = await this._request('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST', body: { refresh_token: pending.refresh_token },
          });
          user = await this._request('/auth/v1/user', { token: session.access_token });
        }
        this.recovery = pending.type === 'recovery';
        this._acceptSession({ ...session, user, expires_at: Number(session.expires_at)
          || Date.now() / 1000 + Number(session.expires_in || 3600) },
        this.recovery ? 'PASSWORD_RECOVERY' : 'SIGNED_IN');
        try { this._callbackStorage?.removeItem(this._pendingKey); } catch { /* Ignore unavailable storage. */ }
      } catch (error) {
        if (error.status >= 400 && error.status < 500) {
          try { this._callbackStorage?.removeItem(this._pendingKey); } catch { /* Ignore unavailable storage. */ }
        }
        throw error;
      }
    } else {
      this._acceptSession(this._storedSession(), 'SIGNED_IN', false);
      if (this.session) {
        const userId = this.user.id;
        try {
          const token = await this._accessToken();
          const generation = this._generation;
          const user = await this._request('/auth/v1/user', { token });
          if (generation === this._generation && this.session?.access_token === token) {
            this._acceptSession({ ...this.session, user }, 'SIGNED_IN');
          }
        } catch (error) {
          this.lastError = error;
          // Network/server failures leave the recoverable session in place.
          if (this.user?.id === userId && (error.status === 401 || error.status === 403)) {
            this._acceptSession(null, 'SIGNED_OUT');
          }
        }
      }
    }
    if (callback?.error) throw new CloudError(callback.error);
    return this.session;
  }

  _takeCallback() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (!params.has('access_token') && !params.has('error') && !params.has('error_description')) return null;
    const callback = {
      access_token: params.get('access_token'), refresh_token: params.get('refresh_token'),
      expires_at: Number(params.get('expires_at')), expires_in: Number(params.get('expires_in')),
      type: params.get('type'), error: safeMessage(params.get('error_description') || params.get('error')),
    };
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    if (callback.access_token && callback.refresh_token) {
      try { this._callbackStorage?.setItem(this._pendingKey, JSON.stringify(callback)); } catch { /* Retry remains possible in memory. */ }
    }
    return callback;
  }

  _storedSession() {
    const id = readJSON(this._storage, this._activeKey);
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const session = readJSON(this._storage, `${this._storagePrefix}${id}`);
    return validSession(session) && session.user.id === id ? session : null;
  }

  _acceptSession(session, event, persist = true) {
    const previousId = this.user?.id;
    if (session?.access_token !== this.session?.access_token || session?.user?.id !== previousId) this._generation += 1;
    this.session = validSession(session) ? session : null;
    if (persist) {
      this._sessionPersisted = false;
      try {
        if (this.session) {
          this._storage?.setItem(`${this._storagePrefix}${this.user.id}`, JSON.stringify(this.session));
          this._storage?.setItem(this._activeKey, JSON.stringify(this.user.id));
          this._sessionPersisted = Boolean(this._storage);
        } else {
          if (previousId) this._storage?.removeItem(`${this._storagePrefix}${previousId}`);
          this._storage?.removeItem(this._activeKey);
        }
      } catch { /* Private/restricted browsing can continue with an in-memory session. */ }
    } else this._sessionPersisted = Boolean(this.session && this._storage);
    if (!this.session) this.recovery = false;
    this._scheduleRefresh();
    this.dispatchEvent(new CustomEvent('auth', { detail: {
      event: this.session ? event : 'SIGNED_OUT', session: this.session, user: this.user,
    } }));
  }

  _scheduleRefresh(delay) {
    clearTimeout(this._refreshTimer);
    if (!this.session || this._disposed) return;
    const wait = delay ?? Math.max(1000, this.session.expires_at * 1000 - Date.now() - REFRESH_MARGIN);
    this._refreshTimer = setTimeout(() => {
      this._refresh().catch((error) => {
        this.lastError = error;
        this._scheduleRefresh(60_000);
      });
    }, Math.min(wait, 2_147_483_647));
  }

  async _withAuthLock(callback) {
    return navigator.locks?.request
      ? navigator.locks.request(`${this._storagePrefix}refresh`, callback) : callback();
  }

  _refresh(force = false) {
    if (this._refreshPromise) return this._refreshPromise;
    const userId = this.user?.id;
    const originalToken = this.session?.access_token;
    this._refreshPromise = this._withAuthLock(async () => {
      const latest = this._storedSession();
      if (!latest && this._sessionPersisted) {
        this._acceptSession(null, 'SIGNED_OUT', false);
        throw new CloudError('You signed out in another tab. Please sign in again.', { status: 401 });
      }
      if (latest && latest.user.id !== userId) {
        this._acceptSession(latest, 'SIGNED_IN', false);
        throw new CloudError('The active account changed. Please try again.', { code: 'account_changed' });
      }
      if (latest && (latest.access_token !== originalToken || !force)
        && latest.expires_at * 1000 > Date.now() + REFRESH_MARGIN) {
        this._acceptSession(latest, 'TOKEN_REFRESHED', false);
        return latest.access_token;
      }
      const current = latest || this.session;
      if (!current?.refresh_token) throw new CloudError('Please sign in to continue.', { status: 401 });
      const generation = this._generation;
      try {
        const result = await this._request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', body: { refresh_token: current.refresh_token },
        });
        const stored = this._storedSession();
        if (generation !== this._generation || userId !== this.user?.id
          || (this._sessionPersisted && stored?.user.id !== userId)) {
          throw new CloudError('The active account changed. Please try again.', { code: 'account_changed' });
        }
        this._setAuthResult(result, 'TOKEN_REFRESHED');
        return this.session.access_token;
      } catch (error) {
        if (generation === this._generation && (error.status === 400 || error.status === 401 || error.status === 403)) {
          this._acceptSession(null, 'SIGNED_OUT');
          throw new CloudError('Your session has expired. Please sign in again.', { status: 401 });
        }
        throw error;
      }
    }).finally(() => { this._refreshPromise = null; });
    return this._refreshPromise;
  }

  _setAuthResult(result, event) {
    const session = { ...result, expires_at: Number(result.expires_at)
      || Date.now() / 1000 + Number(result.expires_in || 3600) };
    if (!validSession(session)) throw new CloudError('The server returned an incomplete session. Please sign in again.');
    this.lastError = null;
    this._acceptSession(session, event);
  }

  async _requireConfigured() {
    await this.init();
    if (!this.configured) throw new CloudError('Cloud sync is not configured yet. Your pages are saved on this device.', {
      code: 'setup_required',
    });
  }

  async _accessToken() {
    if (!this.session) throw new CloudError('Please sign in to continue.', { status: 401 });
    if (this.session.expires_at * 1000 <= Date.now() + REFRESH_MARGIN) return this._refresh();
    return this.session.access_token;
  }

  async _fetchJSON(url, options = {}) {
    let response;
    try { response = await fetch(url, { ...options, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new CloudError('Could not reach cloud storage. Check your connection; your local draft is safe.', {
      code: 'network_error',
    }); }
    if (!response.ok) throw await responseError(response);
    if (response.status === 204 || response.headers.get('content-length') === '0') return null;
    let text;
    try { text = await response.text(); }
    catch { throw new CloudError('The cloud connection was interrupted. Your local draft is safe.', { code: 'network_error' }); }
    if (!text.trim()) return null;
    try { return JSON.parse(text); }
    catch { throw new CloudError('Cloud storage returned an unreadable response. Please try again.'); }
  }

  _request(path, { method = 'GET', body, token, headers = {} } = {}) {
    return this._fetchJSON(`${this._config.url}${path}`, {
      method, headers: {
        apikey: this._config.publishableKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
      }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async _authorized(path, options = {}) {
    await this._requireConfigured();
    const userId = this.user?.id;
    const token = await this._accessToken();
    if (userId !== this.user?.id) throw new CloudError('The active account changed. Please try again.', { code: 'account_changed' });
    const assertAccount = () => {
      if (userId !== this.user?.id) throw new CloudError('The active account changed. Please try again.', { code: 'account_changed' });
    };
    try {
      const result = await this._request(path, { ...options, token });
      assertAccount();
      return result;
    }
    catch (error) {
      if (error.status !== 401) throw error;
      const refreshed = await this._refresh(true);
      if (userId !== this.user?.id) throw new CloudError('The active account changed. Please try again.', { code: 'account_changed' });
      const result = await this._request(path, { ...options, token: refreshed });
      assertAccount();
      return result;
    }
  }

  async signUp(email, password) {
    await this._requireConfigured();
    if (!this.emailDeliveryVerified) {
      throw new CloudError('New accounts are waiting for email delivery. You can sign in with an existing Still or Kickoff account, or keep writing on this device.', {
        code: 'email_delivery_pending',
      });
    }
    if (!email?.trim() || typeof password !== 'string' || password.length < 8) {
      throw new CloudError('Enter an email address and a password with at least 8 characters.');
    }
    const attempt = ++this._authAttempt;
    const health = await this._fetchJSON('/api/health');
    this._assertAuthAttempt(attempt);
    if (health.ready !== true || health.auth?.signupEnabled !== true || health.auth?.emailEnabled !== true
      || health.auth?.emailConfirmationRequired !== true) {
      throw new CloudError('New accounts are temporarily unavailable. Existing accounts and device pages are still available.', {
        code: 'confirmation_policy_unavailable',
      });
    }
    const redirect = encodeURIComponent(`${location.origin}${location.pathname}`);
    const result = await this._request(`/auth/v1/signup?redirect_to=${redirect}`, {
      method: 'POST', body: { email: email.trim(), password },
    });
    this._assertAuthAttempt(attempt);
    if (result.access_token) {
      // The shared account policy requires confirmation before the first sign-in.
      // An unexpected immediate session must not activate a cloud workspace.
      throw new CloudError('This signup did not follow the email confirmation policy. Please contact the app owner before signing in.', {
        code: 'confirmation_policy_unavailable',
      });
    }
    return { session: null, user: result.user || result, confirmationRequired: true };
  }

  async signIn(email, password) {
    await this._requireConfigured();
    if (!email?.trim() || !password) throw new CloudError('Enter your email address and password.');
    const attempt = ++this._authAttempt;
    const result = await this._request('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email: email.trim(), password },
    });
    this._assertAuthAttempt(attempt);
    this.recovery = false;
    this._setAuthResult(result, 'SIGNED_IN');
    return this.session;
  }

  async signOut() {
    await this._requireConfigured();
    const attempt = ++this._authAttempt;
    if (!this.session) return;
    try { await this._authorized('/auth/v1/logout?scope=local', { method: 'POST' }); }
    catch (error) { if (error.status !== 401 && error.status !== 403) throw error; }
    this._assertAuthAttempt(attempt);
    this._acceptSession(null, 'SIGNED_OUT');
  }

  _assertAuthAttempt(attempt) {
    if (attempt !== this._authAttempt) throw new CloudError('The active account changed. Please try again.', { code: 'account_changed' });
  }

  async recover(email) {
    await this._requireConfigured();
    if (!email?.trim()) throw new CloudError('Enter your email address.');
    const redirect = encodeURIComponent(`${location.origin}${location.pathname}`);
    await this._request(`/auth/v1/recover?redirect_to=${redirect}`, {
      method: 'POST', body: { email: email.trim() },
    });
  }

  async updatePassword(password) {
    if (typeof password !== 'string' || password.length < 8) throw new CloudError('Choose a password with at least 8 characters.');
    const user = await this._authorized('/auth/v1/user', { method: 'PUT', body: { password } });
    this.recovery = false;
    this._acceptSession({ ...this.session, user }, 'USER_UPDATED');
    return user;
  }

  async _list(table, fields, order) {
    await this._requireConfigured();
    if (!this.user) throw new CloudError('Please sign in to continue.', { status: 401 });
    const userId = this.user.id;
    const result = [];
    for (let offset = 0; ; offset += 25) {
      const query = new URLSearchParams({ select: fields, user_id: `eq.${userId}`, order, limit: '25', offset: String(offset) });
      const page = await this._authorized(`/rest/v1/${table}?${query}`);
      if (this.user?.id !== userId) throw new CloudError('The active account changed. Please try again.', { code: 'account_changed' });
      if (!Array.isArray(page)) throw new CloudError('Cloud storage returned an unreadable page list.');
      result.push(...page);
      if (page.length < 25) return result;
    }
  }

  listDocuments() { return this._list('documents', DOCUMENT_FIELDS, 'updated_at.desc,id.asc'); }
  listTokens() { return this._list('mcp_tokens', TOKEN_FIELDS, 'created_at.desc,id.asc'); }

  async saveDocument({ id = crypto.randomUUID(), title = '', markdown = '', version = null }) {
    if (!UUID.test(id) || typeof title !== 'string' || title.length > 240
      || typeof markdown !== 'string' || new TextEncoder().encode(markdown).byteLength > 1_048_576
      || (version !== null && (!Number.isSafeInteger(version) || version < 1))) {
      throw new CloudError('Page data is invalid. Titles can be up to 240 characters and pages up to 1 MB.');
    }
    const result = await this._authorized('/rest/v1/rpc/save_document', {
      method: 'POST', body: { p_id: id, p_title: title, p_markdown: markdown, p_expected_version: version },
    });
    if (!result || !UUID.test(result.id)) throw new CloudError('Cloud storage did not confirm the saved page. Your local draft is safe.');
    this.dispatchEvent(new CustomEvent('change', { detail: { type: 'documents' } }));
    return result;
  }

  async deleteDocument(id) {
    if (!UUID.test(id)) throw new CloudError('This page has an invalid identifier.');
    await this._authorized(`/rest/v1/documents?id=eq.${id}`, { method: 'DELETE' });
    this.dispatchEvent(new CustomEvent('change', { detail: { type: 'documents' } }));
  }

  async createToken(name, scope = 'read', days = 90) {
    await this._requireConfigured();
    if (!this.user) throw new CloudError('Please sign in to connect an external app.', { status: 401 });
    const userId = this.user.id;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80
      || !['read', 'write'].includes(scope) || !Number.isInteger(days) || days < 1 || days > 365) {
      throw new CloudError('Choose a token name, read or write access, and an expiry from 1 to 365 days.');
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = `still_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (this.user?.id !== userId) throw new CloudError('The active account changed. Please try again.', { code: 'account_changed' });
    const records = await this._authorized(`/rest/v1/mcp_tokens?select=${TOKEN_FIELDS}`, {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: {
        user_id: userId, name: name.trim(), scope, token_hash: tokenHash,
        expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      },
    });
    const record = records?.[0];
    if (!record?.id) throw new CloudError('Cloud storage did not confirm the new connection. Please try again.');
    this.dispatchEvent(new CustomEvent('change', { detail: { type: 'tokens' } }));
    return { token, record };
  }

  async revokeToken(id) {
    if (!UUID.test(id)) throw new CloudError('This connection has an invalid identifier.');
    await this._authorized(`/rest/v1/mcp_tokens?id=eq.${id}`, { method: 'DELETE' });
    this.dispatchEvent(new CustomEvent('change', { detail: { type: 'tokens' } }));
  }

  dispose() {
    this._disposed = true;
    clearTimeout(this._refreshTimer);
    window.removeEventListener('storage', this._onStorage);
  }
}
