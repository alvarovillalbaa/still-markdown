import { MarkdownEditor } from './editor.js';
import { CloudClient } from './cloud.js';
import { loadWorkspace as loadStoredWorkspace, saveWorkspace } from './storage.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const cloud = new CloudClient();
const MAX_BYTES = 1_048_576;
const encode = new TextEncoder();
let documents = [];
let activeId = null;
let owner = 'guest';
let sourceMode = false;
let authMode = 'signup';
let signupReady = null;
let authDialogGeneration = 0;
let initialized = false;
let workspaceGeneration = 0;
let transitioning = false;
const saveTimers = new Map();
let devicePending = 0;
let deviceUnsafe = false;
let persistenceRevision = 0;
const memoryWorkspaces = new Map();
const unsafeOwners = new Set();
const unreadOwners = new Set();
const saveQueues = new Map();
const deletedIds = new Set();
const context = () => ({ owner, generation: workspaceGeneration });
const sameContext = (ctx) => owner === ctx.owner && workspaceGeneration === ctx.generation;

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { showNotice('Device storage is full or unavailable. Export your page to keep a copy.', true, 'Export page', exportPage); return false; }
}
const storageKey = (user = owner) => `still.pages.${user}`;
function validDocuments(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((d) => d && typeof d.id === 'string' && typeof d.title === 'string'
    && typeof d.markdown === 'string' && d.title.length <= 240 && encode.encode(d.markdown).length <= MAX_BYTES);
}
async function persist() {
  const revision = ++persistenceRevision;
  const user = owner;
  const snapshot = structuredClone(documents);
  memoryWorkspaces.set(user, snapshot);
  if (unreadOwners.has(user)) {
    unsafeOwners.add(user); deviceUnsafe = true;
    showNotice('Existing device drafts could not be read. New edits are kept in this tab; export them before reloading.', true, 'Export page', exportPage);
    return false;
  }
  devicePending++;
  try {
    await saveWorkspace(user, snapshot);
    unsafeOwners.delete(user);
    if (user === owner && revision === persistenceRevision) deviceUnsafe = false;
    return true;
  } catch {
    unsafeOwners.add(user);
    if (user === owner) {
      deviceUnsafe = true;
      showNotice('Device storage is full or unavailable. Export your page to keep a copy.', true, 'Export page', exportPage);
    }
    return false;
  } finally { devicePending--; showSaveState(); }
}
function current() { return documents.find((d) => d.id === activeId); }
function blank(markdown = '', title = '') {
  return { id: crypto.randomUUID(), title, markdown, version: null, dirty: owner !== 'guest',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}
function titleOf(doc) { return doc.title.trim() || 'Untitled'; }
function showNotice(message, error = false, action, callback) {
  $('notice-text').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  $('notice-action').hidden = !action;
  $('notice-action').textContent = action || '';
  $('notice-action').onclick = callback || null;
}
function hideNotice() { $('notice').hidden = true; }
function showSaveState(doc = current()) {
  if (!doc) return;
  const state = deviceUnsafe ? 'Device save failed' : devicePending ? 'Saving draft…' : doc.saving ? 'Saving…' : doc.error ? 'Draft saved on device' : owner === 'guest'
    ? 'Saved on this device' : doc.dirty ? 'Waiting to sync…' : 'All changes saved';
  $('save-state').textContent = state;
  $('save-state').classList.toggle('error', Boolean(doc.error) || deviceUnsafe);
}
function renderList() {
  const list = $('page-list'); list.replaceChildren();
  const query = $('search').value.trim().toLocaleLowerCase();
  const matches = documents.filter((d) => `${titleOf(d)}\n${d.markdown}`.toLocaleLowerCase().includes(query));
  for (const doc of matches) {
    const button = document.createElement('button');
    button.className = `page-item${doc.id === activeId ? ' active' : ''}`;
    button.setAttribute('aria-current', doc.id === activeId ? 'page' : 'false');
    const icon = document.createElement('span'); icon.textContent = '▤'; icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.className = 'page-name'; text.textContent = titleOf(doc);
    button.append(icon, text);
    if (doc.dirty) { const dot = document.createElement('span'); dot.textContent = '·'; dot.className = 'draft-dot'; dot.title = 'Saved device draft; waiting for cloud'; button.append(dot); }
    button.addEventListener('click', () => selectPage(doc.id)); list.append(button);
  }
  $('page-count').textContent = documents.length;
  $('list-message').hidden = matches.length > 0;
  $('list-message').textContent = query ? 'No pages found. Try another word.' : 'A fresh start. Create your first page.';
}
function updateMetadata() {
  const doc = current(); if (!doc) return;
  $('breadcrumb-title').textContent = titleOf(doc);
  document.title = `${titleOf(doc)} — Still`;
  const words = doc.markdown.trim().split(/\s+/u).filter(Boolean).length;
  $('word-count').textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
  $('blank-hint').hidden = Boolean(doc.markdown.trim());
  $('document-date').textContent = doc.markdown.trim() ? new Date(doc.created_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase() : 'A FRESH PAGE';
  showSaveState(doc);
  renderOutline();
}
function renderOutline() {
  const list = $('outline-list'); list.replaceChildren();
  if (sourceMode) { list.textContent = 'Switch to the page to navigate headings.'; return; }
  const headings = [...$('editor').querySelectorAll('h1,h2,h3')];
  headings.forEach((heading, i) => {
    heading.id = `section-${i}`;
    const link = document.createElement('a'); link.href = `#section-${i}`;
    link.textContent = heading.textContent || 'Untitled heading'; link.dataset.level = heading.tagName.slice(1);
    link.addEventListener('click', (event) => { event.preventDefault(); heading.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
    list.append(link);
  });
  if (!headings.length) list.textContent = 'Your headings will appear here.';
}
function selectPage(id) {
  const doc = documents.find((d) => d.id === id); if (!doc) return;
  const outgoing = current();
  if (outgoing && outgoing !== doc && outgoing.dirty) queueSave(outgoing);
  activeId = id;
  write(`still.active.${owner}`, id);
  $('page-title').value = doc.title;
  editor.setMarkdown(doc.markdown);
  $('source').value = doc.markdown;
  $('format-toolbar').hidden = true;
  $('writing-area').scrollTop = 0;
  app.classList.remove('sidebar-open');
  renderList(); updateMetadata();
  if (doc.error) presentSaveError(doc);
}
function pageChanged(markdown) {
  const doc = current(); if (!doc) return;
  if (encode.encode(markdown).length > MAX_BYTES) {
    // Roll back an oversized edit before it can become an unpersisted page state.
    const oversized = markdown;
    if (sourceMode) $('source').value = doc.markdown; else editor.setMarkdown(doc.markdown);
    showNotice('This edit exceeds the 1 MiB page limit and was not applied. You can export the larger text.', true, 'Export larger text', () => download(oversized, titleOf(doc)));
    return;
  }
  doc.markdown = markdown; doc.title = $('page-title').value;
  doc.updated_at = new Date().toISOString(); doc.dirty = owner !== 'guest';
  if (doc.error !== 'document_version_conflict') doc.error = null;
  persist(); renderList(); updateMetadata();
  clearTimeout(saveTimers.get(doc.id));
  if (owner !== 'guest' && !doc.error) saveTimers.set(doc.id, setTimeout(() => { saveTimers.delete(doc.id); queueSave(doc); }, 750));
}
async function queueSave(doc) {
  const user = owner; if (!doc || !documents.includes(doc) || user === 'guest' || !doc.dirty || deletedIds.has(doc.id) || doc.error === 'document_version_conflict') return;
  const key = `${user}:${doc.id}`;
  if (saveQueues.has(key)) return saveQueues.get(key);
  const promise = (async () => {
    while (doc.dirty && documents.includes(doc) && owner === user && cloud.user?.id === user && !deletedIds.has(doc.id)) {
      const snapshot = { id: doc.id, title: doc.title, markdown: doc.markdown, version: doc.version };
      doc.saving = true; showSaveState();
      try {
        const saved = await cloud.saveDocument(snapshot);
        // A stale save must never change the newly selected account or page.
        if (owner !== user || !documents.includes(doc)) return;
        doc.version = saved.version; doc.created_at = saved.created_at;
        doc.dirty = doc.title !== snapshot.title || doc.markdown !== snapshot.markdown;
        doc.error = null;
        if (!doc.dirty) doc.updated_at = saved.updated_at;
        persist();
      } catch (error) {
        if (owner === user && documents.includes(doc)) {
          doc.error = error.code || 'save_failed';
          doc.errorMessage = error.message; persist();
          if (activeId === doc.id) presentSaveError(doc);
        }
        return;
      } finally { doc.saving = false; if (owner === user) { showSaveState(); renderList(); } }
    }
  })().finally(() => saveQueues.delete(key));
  saveQueues.set(key, promise); return promise;
}
function presentSaveError(doc) {
  const ctx = context();
  if (doc.error === 'document_version_conflict') {
    showNotice('This page changed in another client. Your draft is safe on this device.', true, 'Keep draft as a new page', async () => {
      if (!sameContext(ctx) || !documents.includes(doc)) return;
      const copy = blank(doc.markdown, `${titleOf(doc)} (draft)`.slice(0, 240)); documents.unshift(copy);
      doc.dirty = false; doc.error = null;
      const original = { title: doc.title, markdown: doc.markdown };
      const durable = await persist();
      if (!sameContext(ctx)) return;
      if (!durable) { doc.dirty = true; doc.error = 'document_version_conflict'; return; }
      selectPage(copy.id); queueSave(copy); hideNotice();
      // Reloading remote originals happens only after the draft has a separate ID.
      try { const remote = await cloud.listDocuments(); const updated = remote.find((d) => d.id === doc.id); if (updated && sameContext(ctx) && documents.includes(doc) && !doc.dirty && doc.title === original.title && doc.markdown === original.markdown) { Object.assign(doc, updated, { dirty: false, error: null }); persist(); renderList(); if (activeId === doc.id) selectPage(doc.id); } } catch { /* Copy remains recoverable. */ }
    });
  } else showNotice(doc.errorMessage || 'Cloud saving paused. Your draft is safe on this device.', true, 'Try again', () => { if (!sameContext(ctx) || !documents.includes(doc)) return; doc.error = null; queueSave(doc); });
}
async function newPage(markdown = '', title = '', focus = true) {
  if ($('new-page').disabled) return;
  const doc = blank(markdown, title); documents.unshift(doc); persist(); selectPage(doc.id);
  if (focus) $('page-title').focus();
  if (owner !== 'guest') queueSave(doc);
  return doc;
}
async function loadWorkspace() {
  const generation = ++workspaceGeneration;
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
  const previousOwner = owner;
  const persistence = transitioning ? Promise.resolve(true) : persist();
  transitioning = true;
  const nextOwner = cloud.user?.id || 'guest';
  hideNotice(); $('notice-action').onclick = null;
  $('token-value').value = ''; $('token-secret').hidden = true;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('page-title').disabled = true; $('source').disabled = true; $('editor').contentEditable = 'false';
  $('new-page').disabled = true; $('import-button').disabled = true;
  if (previousOwner === nextOwner) {
    await Promise.all([...saveQueues.entries()].filter(([key]) => key.startsWith(`${previousOwner}:`)).map(([, promise]) => promise));
    if (generation !== workspaceGeneration) return;
  }
  activeId = null; documents = [];
  editor.setMarkdown(''); $('source').value = ''; $('page-title').value = '';
  $('page-title').disabled = true; $('source').disabled = true; $('editor').contentEditable = 'false';
  $('new-page').disabled = true; $('import-button').disabled = true;
  renderList(); $('breadcrumb-title').textContent = 'Loading pages…';
  await persistence;
  if (generation !== workspaceGeneration) return;
  owner = nextOwner;
  let cached;
  try {
    if (unreadOwners.has(owner)) {
      cached = validDocuments(await loadStoredWorkspace(owner));
      for (const draft of validDocuments(memoryWorkspaces.get(owner))) if ((draft.title || draft.markdown) && !cached.some((doc) => doc.id === draft.id)) cached.unshift(draft);
      unreadOwners.delete(owner);
    } else cached = unsafeOwners.has(owner) && memoryWorkspaces.has(owner) ? memoryWorkspaces.get(owner) : await loadStoredWorkspace(owner);
  }
  catch { cached = memoryWorkspaces.get(owner) || []; unreadOwners.add(owner); showNotice('Device drafts could not be loaded. Export any new work before closing.', true); deviceUnsafe = true; }
  if (generation !== workspaceGeneration) return;
  documents = validDocuments(cached).map((doc) => ({ ...doc, saving: false }));
  const enable = () => { transitioning = false; $('page-title').disabled = false; $('source').disabled = false; $('editor').contentEditable = 'true'; $('new-page').disabled = false; $('import-button').disabled = false; };
  const cachedId = read(`still.active.${owner}`, null);
  updateAccountUI();
  if (owner === 'guest') {
    if (!documents.length) documents = [blank()];
    persist(); selectPage(documents.some((d) => d.id === cachedId) ? cachedId : documents[0].id); enable(); return;
  }
  if (documents.length) selectPage(documents.some((d) => d.id === cachedId) ? cachedId : documents[0].id);
  $('save-state').textContent = 'Loading pages…';
  try {
    const remote = await cloud.listDocuments();
    if (generation !== workspaceGeneration) return;
    const drafts = documents.filter((doc) => doc.dirty);
    documents = remote.map((doc) => {
      const draft = drafts.find((item) => item.id === doc.id);
      if (!draft) return { ...doc, dirty: false };
      if (draft.title === doc.title && draft.markdown === doc.markdown) return { ...doc, dirty: false };
      if (draft.version !== doc.version) draft.error = 'document_version_conflict';
      return draft;
    });
    for (const draft of drafts) if (!documents.some((doc) => doc.id === draft.id)) documents.unshift(draft);
    if (!documents.length) documents = [blank()];
    persist(); selectPage(documents.some((d) => d.id === activeId) ? activeId : documents[0].id);
    enable(); for (const doc of documents) if (doc.dirty && !doc.error) queueSave(doc);
  } catch (error) {
    if (generation !== workspaceGeneration) return;
    if (!documents.length) { documents = [blank()]; persist(); selectPage(documents[0].id); }
    showNotice(`Could not load cloud pages. ${error.message}`, true, 'Try again', loadWorkspace);
    enable();
  }
}
function updateAccountUI() {
  const user = cloud.user;
  $('account-name').textContent = user?.email || 'Your own little space';
  $('account-detail').textContent = user ? 'Your private workspace' : 'Sign up to keep pages everywhere';
  $('avatar').textContent = user ? (user.email || 's').slice(0, 1).toUpperCase() : '○';
  $('pages-label').textContent = user ? 'YOUR PRIVATE PAGES' : 'ON THIS DEVICE';
  $('storage-label').textContent = user ? 'Private to your account' : 'Private on this device';
  $('guest-upload').hidden = !user;
  $('connect-guest').hidden = Boolean(user); $('connect-account').hidden = !user;
}
function setAuthMode(mode) {
  authMode = mode;
  $('signup-tab').setAttribute('aria-pressed', String(mode === 'signup'));
  $('signin-tab').setAttribute('aria-pressed', String(mode === 'signin'));
  $('auth-tabs').hidden = mode === 'recover' || mode === 'update';
  $('email').hidden = mode === 'update'; $('email').previousElementSibling.hidden = mode === 'update'; $('email').required = mode !== 'update';
  $('password').hidden = mode === 'recover'; $('password-label').hidden = mode === 'recover'; $('password').required = mode !== 'recover';
  $('password').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  $('password').minLength = mode === 'signin' ? 1 : 8;
  $('recover-button').hidden = mode === 'update' || !cloud.passwordRecoveryEnabled;
  $('auth-heading').textContent = ({ signup: 'Make yourself at home.', signin: 'Welcome back.', recover: 'A fresh way back in.', update: 'Choose a new password.' })[mode];
  $('auth-submit').textContent = ({ signup: 'Create your space →', signin: 'Come on in →', recover: 'Send reset email →', update: 'Save password →' })[mode];
  $('auth-error').textContent = ''; $('auth-error').classList.remove('success');
  applyAuthReadiness();
}
function applyAuthReadiness() {
  $('auth-submit').disabled = !cloud.configured || (authMode === 'signup' && signupReady !== true);
  if (authMode === 'signup' && cloud.configured && signupReady === false) $('auth-error').textContent = 'Cloud signup is waiting for email configuration. You can keep writing on this device.';
}
function openAuth(mode = 'signup') {
  setAuthMode(mode); $('auth-dialog').showModal();
  if (!cloud.configured) { $('auth-error').textContent = 'Cloud accounts are not configured yet. Device pages and exports are available.'; $('auth-submit').disabled = true; }
  else {
    const attempt = ++authDialogGeneration;
    fetch('/api/health', { cache: 'no-store' }).then((response) => response.json()).then((health) => {
      if (attempt !== authDialogGeneration || !$('auth-dialog').open) return;
      signupReady = health.ready === true && health.auth?.signupEnabled === true && health.auth?.emailEnabled === true
        && (health.auth.emailConfirmationRequired === false || cloud.passwordRecoveryEnabled);
      $('auth-policy').textContent = health.auth?.emailConfirmationRequired === false
        ? 'No email confirmation is required. Password reset emails are not available yet, so keep your password safe. Device pages stay here until you choose to bring them to the cloud.'
        : 'Email confirmation is currently required. Public signup delivery is waiting for configuration. Device pages and exports are ready.';
      applyAuthReadiness();
    }).catch(() => {
      if (attempt !== authDialogGeneration || !$('auth-dialog').open) return;
      signupReady = false; applyAuthReadiness();
    });
  }
}
function download(markdown, title) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
  link.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 180) || 'Untitled'}.md`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportPage() { const doc = current(); if (doc) download(doc.markdown, titleOf(doc)); }
async function importFiles(files) {
  if (transitioning) { showNotice('Pages are still loading. Try the import again when they are ready.'); return; }
  const ctx = context();
  let imported = 0; const errors = [];
  // Imports are bounded individually and as a batch to avoid exhausting device storage.
  for (const file of [...files].slice(0, 50)) {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) { errors.push(`${file.name}: use .md, .markdown, or .txt`); continue; }
    if (file.size > MAX_BYTES) { errors.push(`${file.name}: larger than 1 MiB`); continue; }
    try {
      const bytes = await file.arrayBuffer();
      if (!sameContext(ctx)) return;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('not a text file');
      const importedPage = await newPage(text, file.name.replace(/\.(md|markdown|txt)$/i, '').slice(0, 240), false); if (importedPage) imported++;
    } catch (error) { errors.push(`${file.name}: ${error.message}`); }
  }
  if (files.length > 50) errors.push('Import up to 50 files at a time.');
  if (errors.length) showNotice(`${imported ? `${imported} imported. ` : ''}${errors.join('; ').slice(0, 500)}`, true);
  else if (imported) showNotice(`${imported} ${imported === 1 ? 'page has' : 'pages have'} a new home.`);
  $('file-input').value = '';
}
async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1800); }
  catch { showNotice('Clipboard is unavailable. Select the text and copy it manually.'); }
}
async function refreshTokens() {
  const ctx = context();
  const list = $('token-list'); list.textContent = 'Loading connections…';
  try {
    const tokens = await cloud.listTokens(); if (!sameContext(ctx)) return; list.replaceChildren();
    if (!tokens.length) { list.textContent = 'No connections yet.'; return; }
    for (const token of tokens) {
      const row = document.createElement('div'); row.className = 'token-row';
      const info = document.createElement('div'); info.textContent = token.name;
      const detail = document.createElement('small'); detail.textContent = `${token.scope === 'write' ? 'Read & write' : 'Read only'} · ${new Date(token.expires_at) < new Date() ? 'Expired' : 'Expires'} ${new Date(token.expires_at).toLocaleDateString()}`;
      info.append(detail); const revoke = document.createElement('button'); revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => { if (!sameContext(ctx)) return; revoke.disabled = true; try { await cloud.revokeToken(token.id); if (sameContext(ctx)) await refreshTokens(); } catch (error) { if (sameContext(ctx)) { $('token-message').textContent = error.message; revoke.disabled = false; } } });
      row.append(info, revoke); list.append(row);
    }
  } catch (error) { if (sameContext(ctx)) list.textContent = error.message; }
}
function openConnect() {
  if (transitioning) return;
  updateAccountUI(); $('mcp-url').value = `${location.origin}/api/mcp`;
  $('token-secret').hidden = true; $('token-value').value = ''; $('token-message').textContent = '';
  $('connect-dialog').showModal(); if (cloud.user) refreshTokens();
}
function closeMenu() { $('page-menu').hidden = true; $('more-button').setAttribute('aria-expanded', 'false'); }

const editor = new MarkdownEditor($('editor'), {
  onChange: pageChanged,
  onSelection: (selection) => {
    if (!selection || sourceMode || document.querySelector('dialog[open]')) { $('format-toolbar').hidden = true; return; }
    const toolbar = $('format-toolbar'); toolbar.hidden = false;
    const width = toolbar.offsetWidth; const height = toolbar.offsetHeight;
    toolbar.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, selection.rect.left + selection.rect.width / 2 - width / 2))}px`;
    toolbar.style.top = `${Math.max(8, selection.rect.top - height - 10 > 8 ? selection.rect.top - height - 10 : Math.min(innerHeight - height - 8, selection.rect.bottom + 10))}px`;
  },
});

$('page-title').addEventListener('input', () => pageChanged(current()?.markdown || ''));
$('source').addEventListener('input', () => pageChanged($('source').value));
$('source').addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return; event.preventDefault();
  const field = event.currentTarget; field.setRangeText('  ', field.selectionStart, field.selectionEnd, 'end'); pageChanged(field.value);
});
$('new-page').addEventListener('click', () => newPage());
$('search').addEventListener('input', renderList);
$('sidebar-toggle').addEventListener('click', () => {
  if (innerWidth <= 760) app.classList.toggle('sidebar-open'); else app.classList.toggle('sidebar-hidden');
});
$('close-sidebar').onclick = $('sidebar-scrim').onclick = () => app.classList.remove('sidebar-open');
$('focus-button').addEventListener('click', () => { app.classList.toggle('focus-mode'); $('focus-button').setAttribute('aria-pressed', String(app.classList.contains('focus-mode'))); editor.focus(); });
$('outline-button').addEventListener('click', () => { $('outline').hidden = !$('outline').hidden; $('outline-button').setAttribute('aria-pressed', String(!$('outline').hidden)); renderOutline(); });
$('source-button').addEventListener('click', () => {
  sourceMode = !sourceMode; $('source-button').setAttribute('aria-pressed', String(sourceMode)); $('format-toolbar').hidden = true;
  if (sourceMode) $('source').value = current()?.markdown || '';
  else editor.setMarkdown(current()?.markdown || '');
  $('editor').hidden = sourceMode; $('source').hidden = !sourceMode;
  if (sourceMode) $('source').focus(); else editor.focus(); renderOutline();
});
$('more-button').addEventListener('click', () => { $('page-menu').hidden = !$('page-menu').hidden; $('more-button').setAttribute('aria-expanded', String(!$('page-menu').hidden)); });
document.addEventListener('click', (event) => { if (!event.target.closest('.menu-wrap')) closeMenu(); });
$('export-button').onclick = () => { exportPage(); closeMenu(); };
$('duplicate-button').onclick = () => { const doc = current(); if (doc) newPage(doc.markdown, `${titleOf(doc)} (copy)`.slice(0, 240)); closeMenu(); };
$('wide-button').onclick = () => { app.classList.toggle('wide-page'); $('wide-button').textContent = app.classList.contains('wide-page') ? '↔ Standard page width' : '↔ Widen page'; closeMenu(); };
let pendingDelete;
$('delete-button').onclick = () => { closeMenu(); pendingDelete = { ...context(), id: activeId }; $('confirm-dialog').showModal(); };
$('confirm-delete').onclick = async () => {
  const ctx = pendingDelete; const doc = documents.find((d) => d.id === ctx?.id); if (!ctx || !sameContext(ctx) || !doc) return;
  $('confirm-delete').disabled = true; deletedIds.add(doc.id);
  try {
    await saveQueues.get(`${owner}:${doc.id}`);
    if (!sameContext(ctx)) return;
    if (owner !== 'guest' && doc.version != null) await cloud.deleteDocument(doc.id);
    if (!sameContext(ctx)) return;
    documents = documents.filter((d) => d !== doc); persist(); $('confirm-dialog').close();
    if (!documents.length) newPage(); else selectPage(documents[0].id);
  } catch (error) { deletedIds.delete(doc.id); showNotice(error.message, true); }
  finally { $('confirm-delete').disabled = false; }
};
$('notice-close').onclick = hideNotice;
$('import-button').onclick = () => $('file-input').click();
$('file-input').addEventListener('change', (event) => importFiles(event.target.files));
let dragDepth = 0;
document.addEventListener('dragenter', (event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); dragDepth++; $('drop-zone').hidden = false; } });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-zone').hidden = true; });
document.addEventListener('dragover', (event) => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
document.addEventListener('drop', (event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); dragDepth = 0; $('drop-zone').hidden = true; importFiles(event.dataTransfer.files); });
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const controls = [...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')]
    .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
  if (!controls.length) { event.preventDefault(); return; }
  const index = controls.indexOf(document.activeElement);
  const next = index < 0 ? 0 : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
  event.preventDefault(); controls[next].focus();
});
$('account-button').onclick = () => { if (cloud.user) { $('account-email').textContent = cloud.user.email; $('account-dialog').showModal(); } else openAuth(); };
$('signup-tab').onclick = () => setAuthMode('signup'); $('signin-tab').onclick = () => setAuthMode('signin');
$('recover-button').onclick = () => setAuthMode(authMode === 'recover' ? 'signin' : 'recover');
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const submit = $('auth-submit'); submit.disabled = true; $('auth-error').textContent = '';
  try {
    if (authMode === 'recover') { await cloud.recover($('email').value.trim()); $('auth-error').classList.add('success'); $('auth-error').textContent = 'If an account exists, a reset link is on its way. Check your email.'; }
    else if (authMode === 'update') { await cloud.updatePassword($('password').value); $('auth-dialog').close(); showNotice('Your password has been updated.'); }
    else if (authMode === 'signup') { const result = await cloud.signUp($('email').value.trim(), $('password').value); if (result.confirmationRequired) { $('auth-error').classList.add('success'); $('auth-error').textContent = 'Check your email to confirm your account, then sign in here.'; } else $('auth-dialog').close(); }
    else { await cloud.signIn($('email').value.trim(), $('password').value); $('auth-dialog').close(); }
    $('password').value = '';
  } catch (error) { $('auth-error').classList.remove('success'); $('auth-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('signout-button').onclick = async () => {
  persist(); $('signout-button').disabled = true;
  try { await cloud.signOut(); $('account-dialog').close(); showNotice('Signed out. Account drafts remain on this device for your next sign-in.'); }
  catch (error) { showNotice(error.message, true); }
  finally { $('signout-button').disabled = false; }
};
$('connect-button').onclick = openConnect;
$('account-connect').onclick = () => { $('account-dialog').close(); openConnect(); };
$('connect-signup').onclick = () => { $('connect-dialog').close(); openAuth(); };
$('copy-endpoint').onclick = () => copyText($('mcp-url').value, $('copy-endpoint'));
$('copy-token').onclick = () => copyText($('token-value').value, $('copy-token'));
$('connect-dialog').addEventListener('close', () => { $('token-value').value = ''; $('token-secret').hidden = true; });
$('token-form').addEventListener('submit', async (event) => {
  const ctx = context();
  event.preventDefault(); $('create-token').disabled = true; $('token-message').textContent = '';
  try { const { token } = await cloud.createToken($('token-name').value, $('token-scope').value); if (!sameContext(ctx)) return; $('token-value').value = token; $('token-secret').hidden = false; $('token-name').value = ''; await refreshTokens(); }
  catch (error) { if (sameContext(ctx)) $('token-message').textContent = error.message; }
  finally { $('create-token').disabled = false; }
});
$('guest-upload').onclick = async () => {
  const ctx = context();
  let guest;
  try { guest = validDocuments(unsafeOwners.has('guest') && memoryWorkspaces.has('guest') ? memoryWorkspaces.get('guest') : await loadStoredWorkspace('guest')).filter((d) => d.markdown || d.title); }
  catch { showNotice('Could not read device pages. Please try again.', true); return; }
  if (!sameContext(ctx)) return;
  if (!guest.length) return; $('guest-upload').disabled = true;
  try {
    for (const doc of guest) { if (!sameContext(ctx)) return; await newPage(doc.markdown, doc.title, false); }
    showNotice(`${guest.length} device pages copied to this account. Originals remain on this device.`);
  } finally { $('guest-upload').disabled = false; }
};
$('theme-button').onclick = () => { document.body.classList.toggle('dark'); write('still.theme', document.body.classList.contains('dark') ? 'dark' : 'light'); };
if (read('still.theme', 'light') === 'dark') document.body.classList.add('dark');
$('format-toolbar').addEventListener('pointerdown', (event) => { if (!event.target.closest('select')) event.preventDefault(); });
$('writing-area').addEventListener('scroll', () => { $('format-toolbar').hidden = true; }, { passive: true });
window.addEventListener('resize', () => { $('format-toolbar').hidden = true; });
for (const button of document.querySelectorAll('[data-format]')) button.onclick = () => {
  if (button.dataset.format === 'link') { $('link-url').value = ''; $('link-error').textContent = ''; $('link-dialog').showModal(); $('format-toolbar').hidden = true; }
  else editor.format(button.dataset.format);
};
$('text-style').addEventListener('change', (event) => { editor.format(event.target.value); event.target.value = 'paragraph'; });
$('link-form').addEventListener('submit', (event) => {
  event.preventDefault(); const url = $('link-url').value.trim();
  if (!/^(https?:|mailto:)/i.test(url)) { $('link-error').textContent = 'Use an https, http, or mailto address.'; return; }
  $('link-dialog').close(); editor.format('link', url);
});
document.addEventListener('keydown', (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === 'Escape') { closeMenu(); $('format-toolbar').hidden = true; app.classList.remove('sidebar-open'); }
  if (!mod || document.querySelector('dialog[open]')) return;
  if (event.key.toLowerCase() === 'k' && !event.shiftKey) { event.preventDefault(); app.classList.remove('sidebar-hidden', 'focus-mode'); if (innerWidth <= 760) app.classList.add('sidebar-open'); $('search').focus(); }
  if (event.key.toLowerCase() === 'n') { event.preventDefault(); newPage(); }
  if (event.key.toLowerCase() === 's') { event.preventDefault(); if (owner !== 'guest') queueSave(current()); else persist(); }
});
window.addEventListener('online', () => { if (owner !== 'guest') for (const doc of documents) if (doc.dirty && doc.error !== 'document_version_conflict') { doc.error = null; queueSave(doc); } });
window.addEventListener('beforeunload', (event) => { if (devicePending || deviceUnsafe || unsafeOwners.size || documents.some((d) => d.dirty)) { event.preventDefault(); event.returnValue = ''; } });
cloud.addEventListener('auth', ({ detail }) => {
  if (!initialized) return;
  if ((detail.user?.id || 'guest') !== owner) loadWorkspace();
  if (detail.event === 'PASSWORD_RECOVERY') openAuth('update');
});

// Device pages are usable immediately, including while the network is unavailable.
try { documents = validDocuments(await loadStoredWorkspace('guest')); }
catch { documents = []; unreadOwners.add('guest'); deviceUnsafe = true; showNotice('Device drafts could not be loaded. Export your work before closing.', true); }
if (!documents.length) documents = [blank()];
selectPage(read('still.active.guest', documents[0].id)); if (!current()) selectPage(documents[0].id); persist();
try { await cloud.init(); }
catch (error) { showNotice(error.message, true); }
initialized = true;
if (cloud.user) await loadWorkspace(); else updateAccountUI();
if (cloud.recovery) openAuth('update');
