// Tier 2: authored in-memory frontend state. The complete app source executes
// against controlled platform boundaries; no browser, backend or network runs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const appPath = process.env.STILL_APP_SOURCE || new URL('../public/app.js', import.meta.url);
const source = await readFile(appPath, 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const elements = [...html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)];
const copy = (value) => structuredClone(value);
const page = (id, overrides = {}) => ({
  id, title: 'Authored page ' + id, markdown: '# Authored source\n', dirty: false,
  version: null, created_at: '2026-10-27T12:00:00.000Z', updated_at: '2026-10-27T12:00:00.000Z', ...overrides,
});
const invalidPage = () => page('unread-page', { title: 'x'.repeat(241), markdown: 'Text that must remain recoverable.' });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function environment(initial = [page('one')], { initialReadError = false } = {}) {
  const records = new Map([['guest', copy(initial)]]);
  const writes = [], reads = [], downloads = [], cloudWrites = [];
  const scriptedReads = new Map(), remote = new Map(), urls = new Map(), failingWrites = new Set();
  const nodes = new Map(), timers = new Map(), windowListeners = new Map(), documentListeners = new Map();
  let sequence = 0, timerId = 0, app, afterSave;
  function node(tag = 'div', id = '') {
    const attributes = new Map(), classes = new Set(), listeners = new Map();
    return {
      id, tagName: tag.toUpperCase(), value: '', textContent: '', hidden: false,
      disabled: false, children: [], dataset: {}, style: {}, open: false,
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, force) {
          const next = force === undefined ? !classes.has(name) : Boolean(force);
          if (next) classes.add(name); else classes.delete(name);
          return next;
        },
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, callback) {
        const values = listeners.get(name) || []; values.push(callback); listeners.set(name, values);
      },
      async dispatch(name, detail = {}) {
        const event = { target: this, currentTarget: this, preventDefault() {}, ...detail };
        if (typeof this['on' + name] === 'function') await this['on' + name](event);
        for (const callback of listeners.get(name) || []) await callback(event);
      },
      click() {
        if (this.tagName === 'A' && this.download) downloads.push({ filename: this.download, blob: urls.get(this.href) });
        else return this.dispatch('click');
      },
      focus() { document.activeElement = this; },
      remove() {}, close() { this.open = false; }, showModal() { this.open = true; },
      querySelectorAll() { return []; }, getClientRects() { return [{}]; },
    };
  }
  for (const [markup, tag, id] of elements) {
    const element = node(tag, id); element.hidden = /\shidden(?:\s|=|>)/.test(markup);
    element.disabled = /\sdisabled(?:\s|=|>)/.test(markup); nodes.set(id, element);
  }
  const fileInput = nodes.get('file-input');
  let fileValue = '';
  fileInput.files = [];
  Object.defineProperty(fileInput, 'value', {
    get() { return fileValue; },
    set(value) { fileValue = String(value); if (fileValue === '') fileInput.files.length = 0; },
  });
  // Baseline source uses the current harmless platform boundary. New controls
  // are present but have no callback until the actual new app registers one.
  for (const id of ['recovery-panel', 'export-recovery', 'retry-workspace']) {
    if (!nodes.has(id)) { const element = node('div', id); element.hidden = true; nodes.set(id, element); }
  }
  const document = {
    body: node('body'), title: '', activeElement: null,
    getElementById(id) { assert.ok(nodes.has(id), 'Unmodeled app element: ' + id); return nodes.get(id); },
    createElement: (tag) => node(tag),
    addEventListener(name, callback) {
      const values = documentListeners.get(name) || []; values.push(callback); documentListeners.set(name, values);
    },
    querySelectorAll() { return []; }, querySelector() { return null; },
  };
  const local = new Map();
  class CloudClient {
    user = null;
    recovery = false;
    configured = false;
    listeners = new Map();
    async init() {}
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    async listDocuments() { return copy(remote.get(this.user?.id) || []); }
    async saveDocument(document) {
      cloudWrites.push({ owner: this.user?.id, document: copy(document) });
      return { ...copy(document), version: (document.version || 0) + 1,
        created_at: '2026-10-27T12:00:00.000Z', updated_at: '2026-10-27T12:00:00.000Z' };
    }
  }
  class MarkdownEditor {
    constructor(element, callbacks) { this.element = element; this.callbacks = callbacks; }
    setMarkdown(markdown) { this.markdown = markdown; }
    focus() {} format() {}
  }
  if (initialReadError) scriptedReads.set('guest', [() => { throw new Error('Authored load failure'); }]);
  const context = vm.createContext({
    document, MarkdownEditor, CloudClient, TextEncoder, TextDecoder, Blob, DOMException,
    structuredClone, console, innerWidth: 1440, innerHeight: 1000,
    location: { origin: 'https://authored-still.invalid' },
    crypto: { randomUUID: () => 'authored-new-' + (++sequence) },
    URL: { createObjectURL(blob) { const url = 'blob:authored-' + (++sequence); urls.set(url, blob); return url; }, revokeObjectURL(url) { urls.delete(url); } },
    localStorage: { getItem: (key) => local.get(key) ?? null, setItem: (key, value) => local.set(key, String(value)) },
    navigator: { clipboard: { writeText() { throw new Error('Clipboard is outside recovery checks.'); } } },
    window: { addEventListener(name, callback) { windowListeners.set(name, callback); } },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch() { throw new Error('Network is forbidden in in-memory recovery checks.'); },
    async loadStoredWorkspace(user) {
      reads.push(user);
      const callbacks = scriptedReads.get(user);
      if (callbacks?.length) return copy(await callbacks.shift()());
      return copy(records.get(user) ?? null);
    },
    async saveWorkspace(user, documents) {
      writes.push({ owner: user, documents: copy(documents) });
      if (failingWrites.has(user)) throw new Error('Authored device write failure');
      records.set(user, copy(documents));
      const callback = afterSave; afterSave = null; callback?.();
    },
  });
  const stripped = source.replace(/^import [^\n]+;\s*$/gm, '');
  const adapter = `
    return { cloud, loadWorkspace, persist, newPage, pageChanged, current, selectPage, showNotice, importFiles,
      state: () => ({ owner, documents: structuredClone(documents), activeId,
        unread: [...unreadOwners], unsafe: [...unsafeOwners], deviceUnsafe, transitioning,
        recovery: typeof recoverySnapshots === 'undefined' ? null : structuredClone([...recoverySnapshots]) }) };
  `;
  app = await vm.runInContext('(async () => {\n' + stripped + '\n' + adapter + '\n})()', context, { filename: String(appPath) });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await flush();
  return {
    app, nodes, records, writes, reads, downloads, cloudWrites,
    get state() { return copy(app.state()); },
    set(user, documents) { records.set(user, copy(documents)); },
    script(user, callback) { const queue = scriptedReads.get(user) || []; queue.push(callback); scriptedReads.set(user, queue); },
    remote(user, documents) { remote.set(user, copy(documents)); },
    async switch(user) { app.cloud.user = user ? { id: user, email: user + '@example.invalid' } : null; await app.loadWorkspace(); await flush(); },
    async click(id) { await nodes.get(id).dispatch('click'); await flush(); },
    async edit(markdown, title = 'Authored tab edit') { nodes.get('page-title').value = title; app.pageChanged(markdown); await flush(); },
    selectFiles(files, value = 'authored-selection.md') { fileInput.files = [...files]; fileInput.value = value; },
    pick(files, value = 'authored-selection.md') { this.selectFiles(files, value); return fileInput.dispatch('change'); },
    async drop(files) {
      const event = { dataTransfer: { files, types: ['Files'] }, prevented: false, preventDefault() { this.prevented = true; } };
      for (const callback of documentListeners.get('drop') || []) callback(event);
      await flush(); return event;
    },
    onNextSave(callback) { afterSave = callback; },
    failSaves(user = 'guest') { failingWrites.add(user); },
    async waitForRead(user, count = 1) {
      for (let i = 0; i < 100; i++) { if (reads.filter((item) => item === user).length >= count) return; await Promise.resolve(); }
      throw new Error('Expected read did not start: ' + user);
    },
    flush,
    unloadBlocked() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; windowListeners.get('beforeunload')(event); return event.prevented; },
  };
}

function protectedSnapshot(h, original, user = 'guest') {
  assert.equal(h.writes.filter((write) => write.owner === user).length, 0, 'No automatic write may replace an unread snapshot.');
  assert.deepEqual(h.records.get(user), original);
  assert.ok(h.state.unread.includes(user));
}

test('protects the complete mixed-row snapshot during actual guest startup', async () => {
  const original = [page('readable'), invalidPage()];
  const h = await environment(original);
  protectedSnapshot(h, original);
  assert.equal(h.state.documents.some((doc) => doc.id === 'readable'), false, 'A rejected snapshot is not partially hydrated.');
  assert.equal(h.unloadBlocked(), true);
});

test('protects all-invalid rows instead of replacing them with a blank saved page', async () => {
  const original = [invalidPage(), { id: 'missing-markdown', title: 'Recover this title' }];
  const h = await environment(original);
  protectedSnapshot(h, original);
  await h.edit('New work stays in this tab.');
  protectedSnapshot(h, original);
  assert.ok(h.state.documents.some((doc) => doc.markdown === 'New work stays in this tab.'));
});

test('protects duplicate page identities before hydration or automatic saving', async () => {
  const original = [page('duplicate', { markdown: 'First distinct source' }), page('duplicate', { markdown: 'Second distinct source' })];
  protectedSnapshot(await environment(original), original);
});

test('protects sparse stored arrays rather than silently discarding their holes', async () => {
  const original = new Array(3); original[0] = page('before-hole'); original[2] = page('after-hole');
  protectedSnapshot(await environment(original), original);
});

test('protects UTF-8-oversized Markdown and missing fields without truncating stored text', async () => {
  const scenarios = [];
  for (const invalid of [page('unicode', { markdown: '界'.repeat(350_000) }), { id: 'missing-title', markdown: 'Original source' }, page('', { markdown: 'Empty identity still has text.' })]) {
    const original = [invalid]; scenarios.push({ original, h: await environment(original) });
  }
  for (const { h, original } of scenarios) protectedSnapshot(h, original);
});

test('keeps valid and empty guest snapshots working through the existing save path', async () => {
  const original = [page('one', { markdown: 'Exact source\r\n\r\n', extra: { preserve: true } })];
  const h = await environment(original);
  assert.deepEqual(h.records.get('guest'), original);
  assert.equal(h.state.unread.length, 0);
  await h.edit('Updated valid source', 'Updated title');
  assert.equal(h.records.get('guest')[0].markdown, 'Updated valid source');
  const empty = await environment([]);
  assert.equal(empty.state.documents.length, 1); assert.equal(empty.state.unread.length, 0);
  assert.equal(empty.records.get('guest').length, 1);
});

test('protects unread guest rows when returning from an account workspace', async () => {
  const h = await environment(); const account = page('account-page');
  h.remote('account-a', [account]); await h.switch('account-a');
  const original = [page('returning'), invalidPage()]; h.set('guest', original); h.writes.length = 0;
  await h.switch(null);
  protectedSnapshot(h, original);
  assert.equal(h.state.owner, 'guest');
});

test('protects an unread account snapshot while retaining fetched cloud pages separately', async () => {
  const h = await environment(); const original = [page('cached'), invalidPage()];
  h.set('account-a', original); h.remote('account-a', [page('remote')]); h.writes.length = 0;
  await h.switch('account-a');
  protectedSnapshot(h, original, 'account-a');
  assert.ok(h.state.documents.some((doc) => doc.id === 'remote'));
});

test('protects the new owner from a stale previous-owner read failure', async () => {
  const h = await environment(), gate = deferred();
  h.script('account-a', () => gate.promise);
  const first = h.switch('account-a'); await h.waitForRead('account-a');
  h.set('account-b', [page('cached-b')]); h.remote('account-b', [page('remote-b')]);
  await h.switch('account-b'); const before = h.state;
  gate.reject(new Error('Late authored account-a read failure')); await first;
  assert.equal(h.state.owner, 'account-b'); assert.deepEqual(h.state.documents, before.documents);
  assert.deepEqual(h.state.unread, before.unread, 'A stale catch must not mark the current owner unread.');
  assert.deepEqual(h.state.recovery, before.recovery);
});

test('a stale malformed previous-owner result cannot publish recovery data into the current workspace', async () => {
  const h = await environment(), gate = deferred();
  h.script('account-a', () => gate.promise);
  const first = h.switch('account-a'); await h.waitForRead('account-a');
  h.remote('account-b', [page('remote-b')]); await h.switch('account-b'); const before = h.state;
  gate.resolve([invalidPage()]); await first;
  assert.equal(h.state.owner, 'account-b'); assert.deepEqual(h.state.documents, before.documents);
  assert.deepEqual(h.state.unread, before.unread); assert.deepEqual(h.state.recovery, before.recovery);
});

test('protects guest-copy completeness instead of reporting a successful partial copy', async () => {
  const h = await environment(); h.remote('account-a', [page('account-original')]); await h.switch('account-a');
  const original = [page('valid-guest-copy'), invalidPage()]; h.set('guest', original);
  const before = h.state.documents, cloudBefore = h.cloudWrites.length;
  await h.click('guest-upload');
  assert.deepEqual(h.state.documents, before);
  assert.equal(h.cloudWrites.length, cloudBefore); assert.deepEqual(h.records.get('guest'), original);
  assert.doesNotMatch(h.nodes.get('notice-text').textContent, /pages copied|page copied/i);
});

test('guest copy rejects ambiguous duplicate IDs as a whole', async () => {
  const h = await environment(); h.remote('account-a', [page('account-original')]); await h.switch('account-a');
  const original = [page('duplicate', { markdown: 'First' }), page('duplicate', { markdown: 'Second' })];
  h.set('guest', original); const before = h.state.documents;
  await h.click('guest-upload'); assert.deepEqual(h.state.documents, before); assert.deepEqual(h.records.get('guest'), original);
});

test('guest copy stays blocked after external correction until guest recovery also preserves its tab drafts', async () => {
  const h = await environment([invalidPage()]); await h.edit('Guest work retained only in this tab');
  h.remote('account-a', [page('account-original')]); await h.switch('account-a');
  h.set('guest', [page('externally-corrected')]); const before = h.state.documents, cloudBefore = h.cloudWrites.length;
  const readsBefore = h.reads.length; await h.click('guest-upload');
  assert.deepEqual(h.state.documents, before); assert.equal(h.cloudWrites.length, cloudBefore);
  assert.equal(h.reads.length, readsBefore, 'Copy must not bypass the unresolved guest gate with another filtered read.');
  assert.ok(h.state.unread.includes('guest'));
  assert.match(h.nodes.get('notice-text').textContent, /recovery|recover|sign out/i);
});

test('a failed recovery retry retains original rows and every newer in-tab page', async () => {
  const original = [page('one'), invalidPage()], h = await environment(original);
  await h.edit('First authored tab page'); await h.app.newPage('Second authored tab page', 'Second tab title', false); await h.flush();
  const before = h.state.documents;
  await h.click('retry-workspace');
  protectedSnapshot(h, original);
  // Reopening resets the transient in-flight-save flag. Every other field and
  // the full page list must survive a failed retry.
  const withoutSaving = (rows) => rows.map(({ saving, ...document }) => document);
  assert.deepEqual(withoutSaving(h.state.documents), withoutSaving(before));
  assert.equal(h.nodes.get('recovery-panel').hidden, false);
});

test('a corrected full reread keeps conflicting same-ID tab edits as separate pages before saving', async () => {
  const h = await environment([invalidPage()]);
  await h.edit('Newer in-tab source', 'Exact newer title'); const edited = h.state.documents[0];
  await h.app.newPage('Another tab source', 'Another title', false); await h.flush();
  const corrected = [page(edited.id, { title: 'Corrected saved title', markdown: 'Corrected saved source' }), page('restored-other')];
  h.set('guest', corrected); await h.click('retry-workspace');
  const saved = h.records.get('guest');
  assert.ok(saved.some((doc) => doc.id === edited.id && doc.markdown === 'Corrected saved source'));
  assert.ok(saved.some((doc) => doc.id !== edited.id && doc.markdown === 'Newer in-tab source' && doc.title === 'Exact newer title'));
  assert.ok(saved.some((doc) => doc.markdown === 'Another tab source'));
  assert.equal(new Set(saved.map((doc) => doc.id)).size, saved.length);
  assert.equal(h.state.unread.includes('guest'), false); assert.equal(h.nodes.get('recovery-panel').hidden, true);
});

test('a corrected retry retains deliberately created blank tab pages with their own identities', async () => {
  const h = await environment([invalidPage()]); await h.app.newPage('', '', false); await h.flush();
  const blankIds = h.state.documents.map((doc) => doc.id); assert.equal(blankIds.length, 2);
  h.set('guest', [page('corrected-saved')]); await h.click('retry-workspace');
  const saved = h.records.get('guest');
  for (const id of blankIds) assert.ok(saved.some((doc) => doc.id === id && doc.title === '' && doc.markdown === ''));
  assert.ok(saved.some((doc) => doc.id === 'corrected-saved')); assert.equal(h.state.unread.includes('guest'), false);
});

test('recovery export includes original rows and current tab pages without releasing the write gate', async () => {
  const original = [page('one'), invalidPage()], h = await environment(original);
  await h.edit('Recovery tab source', 'Recovery tab title'); await h.click('export-recovery');
  assert.equal(h.downloads.length, 1); const download = h.downloads[0];
  assert.match(download.filename, /\.json$/); assert.match(download.blob.type, /^application\/json/);
  const archive = JSON.parse(await download.blob.text());
  assert.equal(archive.format, 'still-recovery'); assert.equal(archive.version, 1);
  assert.deepEqual(archive.savedPages, original);
  assert.ok(archive.tabPages.some((doc) => doc.markdown === 'Recovery tab source' && doc.title === 'Recovery tab title'));
  protectedSnapshot(h, original);
});

test('a recovery export after an unreadable load honestly includes only available tab pages', async () => {
  const original = [page('unavailable-stored')], h = await environment(original, { initialReadError: true });
  await h.edit('Available tab source', 'Available tab title'); await h.click('export-recovery');
  assert.equal(h.downloads.length, 1);
  const archive = JSON.parse(await h.downloads[0].blob.text());
  assert.equal(archive.savedPages, null);
  assert.ok(archive.tabPages.some((doc) => doc.markdown === 'Available tab source'));
  assert.match(h.nodes.get('notice-text').textContent, /only this tab.*saved pages could not be read/i);
  assert.match(h.nodes.get('notice-text').textContent, /saving remains paused/i);
  protectedSnapshot(h, original);
});

test('an unserializable recovery export fails visibly while preserving the snapshot and save gate', async () => {
  const invalid = invalidPage(); invalid.circular = invalid;
  const original = [invalid], h = await environment(original);
  await h.click('export-recovery');
  assert.equal(h.downloads.length, 0); protectedSnapshot(h, original);
  assert.match(h.nodes.get('notice-text').textContent, /could not|cannot|failed/i);
  assert.equal(h.nodes.get('recovery-panel').hidden, false);
});

test('recovery export rejects lossy Date, undefined and sparse-array JSON conversions', async () => {
  const withDate = invalidPage(); withDate.extra = new Date('2026-10-27T12:00:00.000Z');
  const withUndefined = invalidPage(); withUndefined.extra = undefined;
  const sparse = new Array(2); sparse[1] = invalidPage();
  for (const original of [[withDate], [withUndefined], sparse]) {
    const h = await environment(original); await h.click('export-recovery');
    assert.equal(h.downloads.length, 0, 'A purported complete recovery copy must not silently normalize unsupported data.');
    protectedSnapshot(h, original); assert.match(h.nodes.get('notice-text').textContent, /complete recovery|could not|cannot/i);
  }
});

test('recovery actions remain reachable after notices change or are dismissed', async () => {
  const original = [invalidPage()], h = await environment(original);
  h.app.showNotice('An unrelated temporary notice'); await h.click('notice-close');
  assert.equal(h.nodes.get('notice').hidden, true); assert.equal(h.nodes.get('recovery-panel').hidden, false);
  await h.click('export-recovery'); assert.equal(h.downloads.length, 1); protectedSnapshot(h, original);
});

test('a read failure does not overwrite committed data and a later complete retry resumes saving', async () => {
  const original = [page('stored')], h = await environment(original, { initialReadError: true });
  protectedSnapshot(h, original); await h.edit('Created while reading was unavailable');
  await h.click('retry-workspace');
  assert.equal(h.state.unread.includes('guest'), false);
  assert.ok(h.records.get('guest').some((doc) => doc.id === 'stored'));
  assert.ok(h.records.get('guest').some((doc) => doc.markdown === 'Created while reading was unavailable'));
});

test('ordinary Markdown export retains exact source and its existing file type', async () => {
  const original = page('one', { title: 'Authored exported page', markdown: '# Exact source\r\n\r\n' });
  const h = await environment([original]); await h.click('export-button');
  assert.equal(h.downloads.length, 1); assert.equal(h.downloads[0].filename, 'Authored exported page.md');
  assert.match(h.downloads[0].blob.type, /^text\/markdown/); assert.equal(await h.downloads[0].blob.text(), original.markdown);
});

function importedFile(name, text = '# Authored imported source\n', { gate, bytes, size } = {}) {
  const encoded = bytes ?? new TextEncoder().encode(text), calls = { reads: 0 };
  return {
    name, size: size ?? encoded.byteLength, calls,
    async arrayBuffer() { calls.reads++; if (gate) await gate.promise; return encoded.slice().buffer; },
  };
}
function feedback(h) {
  return {
    text: h.nodes.get('notice-text').textContent, hidden: h.nodes.get('notice').hidden,
    error: h.nodes.get('notice').classList.contains('error'),
    action: h.nodes.get('notice-action').textContent, actionHidden: h.nodes.get('notice-action').hidden,
  };
}

test('imports preserve exact UTF-8 source through the actual picker and immediate live-list clearing', async () => {
  const h = await environment(), markdown = '# Authored\r\n\r\nEspañol 漢字 🟠\r\n', file = importedFile('Exact source.MARKDOWN', markdown);
  const pending = h.pick([file]);
  assert.equal(h.nodes.get('file-input').value, '', 'The picker must clear before its callback yields.');
  assert.equal(h.nodes.get('file-input').files.length, 0, 'The app must snapshot files before the live chooser clears.');
  await pending; await h.flush();
  const imported = h.state.documents.find(doc => doc.title === 'Exact source');
  assert.ok(imported); assert.equal(imported.markdown, markdown); assert.equal(file.calls.reads, 1);
  assert.ok(h.records.get('guest').some(doc => doc.id === imported.id && doc.markdown === markdown));
  assert.match(feedback(h).text, /^1 page has a new home\./);
});

test('imports keep a newer picker selection after an older read finishes', async () => {
  const h = await environment(), gate = deferred(), old = importedFile('Older.md', 'Older source', { gate });
  const pending = h.pick([old]);
  const next = importedFile('Next.md'); h.selectFiles([next], 'next-native-selection.md');
  gate.resolve(); await pending; await h.flush();
  assert.equal(h.nodes.get('file-input').value, 'next-native-selection.md');
  assert.deepEqual(h.nodes.get('file-input').files, [next]);
  assert.ok(h.state.documents.some(doc => doc.title === 'Older')); assert.equal(next.calls.reads, 0);
});

test('imports dropped files without resetting an unrelated native picker selection', async () => {
  const h = await environment(), selected = importedFile('Unsubmitted picker.md'); h.selectFiles([selected], 'native-picker-selection.md');
  const event = await h.drop([importedFile('Dropped.txt', 'Drop source\r\n')]);
  assert.equal(event.prevented, true); assert.equal(h.nodes.get('file-input').value, 'native-picker-selection.md');
  assert.deepEqual(h.nodes.get('file-input').files, [selected]); assert.equal(selected.calls.reads, 0);
  assert.ok(h.state.documents.some(doc => doc.title === 'Dropped' && doc.markdown === 'Drop source\r\n'));
});

test('imports reject current unsupported and oversized files before reading their bytes', async () => {
  const h = await environment(), unsupported = importedFile('Not Markdown.pdf'), oversized = importedFile('Too large.md', '', { size: 1_048_577 });
  const before = h.state.documents; await h.app.importFiles([unsupported, oversized]); await h.flush();
  assert.deepEqual(h.state.documents, before); assert.equal(unsupported.calls.reads, 0); assert.equal(oversized.calls.reads, 0);
  assert.match(feedback(h).text, /Not Markdown\.pdf: use \.md/); assert.match(feedback(h).text, /Too large\.md: larger than 1 MiB/);
  assert.equal(feedback(h).error, true);
});

test('imports reject invalid UTF-8 and NUL text without creating pages', async () => {
  const h = await environment(), before = h.state.documents;
  await h.app.importFiles([importedFile('Invalid encoding.md', '', { bytes: new Uint8Array([0xff, 0x61]) }), importedFile('Nul text.txt', 'before\0after')]);
  await h.flush(); assert.deepEqual(h.state.documents, before); assert.equal(feedback(h).error, true);
  assert.match(feedback(h).text, /Invalid encoding\.md/); assert.match(feedback(h).text, /Nul text\.txt: not a text file/);
});

test('imports retain the exact one-MiB boundary and existing title limit', async () => {
  const h = await environment(), text = 'x'.repeat(1_048_576), title = 'a'.repeat(250);
  await h.app.importFiles([importedFile(title + '.md', text)]); await h.flush();
  const imported = h.state.documents.find(doc => doc.title === 'a'.repeat(240));
  assert.ok(imported); assert.equal(imported.markdown, text); assert.match(feedback(h).text, /^1 page has a new home\./);
});

test('imports preserve the original fifty-file cap and warning when the supplied live list changes', async () => {
  const h = await environment(), gate = deferred();
  const originals = Array.from({ length: 51 }, (_, index) => importedFile('Batch ' + index + '.md', 'Source ' + index, index === 0 ? { gate } : {}));
  const live = [...originals], pending = h.app.importFiles(live); live.length = 0; gate.resolve();
  await pending; await h.flush();
  assert.equal(h.state.documents.filter(doc => doc.title.startsWith('Batch ')).length, 50);
  assert.equal(originals.slice(0, 50).every(file => file.calls.reads === 1), true); assert.equal(originals[50].calls.reads, 0);
  assert.match(feedback(h).text, /Import up to 50 files at a time/);
});

test('imports ignore a failed read from the previous account without changing the current notice or chooser', async () => {
  const h = await environment(), gate = deferred(), pending = h.app.importFiles([importedFile('Guest pending.md', '', { gate })]);
  h.remote('account-a', [page('account-original')]); await h.switch('account-a');
  h.app.showNotice('Current account notice', true, 'Current action', () => {}); h.selectFiles([importedFile('Current selection.md')], 'current-account-selection.md');
  const before = h.state, notice = feedback(h), writes = h.writes.length, cloudWrites = h.cloudWrites.length;
  gate.reject(new Error('Obsolete guest file read failed')); await pending; await h.flush();
  assert.deepEqual(h.state, before); assert.deepEqual(feedback(h), notice);
  assert.equal(h.nodes.get('file-input').value, 'current-account-selection.md');
  assert.equal(h.writes.length, writes); assert.equal(h.cloudWrites.length, cloudWrites);
});

test('imports retain the existing successful-read fence across an account transition', async () => {
  const h = await environment(), gate = deferred(), pending = h.app.importFiles([importedFile('Guest late success.md', 'Guest-only source', { gate })]);
  h.remote('account-a', [page('account-original')]); await h.switch('account-a');
  h.app.showNotice('Keep this account notice'); h.selectFiles([importedFile('Keep selected.md')], 'keep-selected.md');
  const before = h.state, notice = feedback(h); gate.resolve(); await pending; await h.flush();
  assert.deepEqual(h.state, before); assert.deepEqual(feedback(h), notice); assert.equal(h.nodes.get('file-input').value, 'keep-selected.md');
});

test('imports ignore a stale read failure after a same-owner workspace retry', async () => {
  const h = await environment(), gate = deferred(), pending = h.app.importFiles([importedFile('Before retry.md', '', { gate })]);
  await h.app.loadWorkspace(); await h.flush(); h.app.showNotice('Notice after guest retry');
  h.selectFiles([importedFile('After retry.md')], 'after-retry-selection.md'); const before = h.state, notice = feedback(h);
  gate.reject(new Error('Obsolete retry read failed')); await pending; await h.flush();
  assert.equal(h.state.owner, 'guest'); assert.deepEqual(h.state, before); assert.deepEqual(feedback(h), notice);
  assert.equal(h.nodes.get('file-input').value, 'after-retry-selection.md');
});

test('imports reject stale feedback after guest-account-guest ABA transitions', async () => {
  const h = await environment(), gate = deferred(), pending = h.app.importFiles([importedFile('Old guest.md', '', { gate })]);
  h.remote('account-a', [page('account-original')]); await h.switch('account-a'); await h.switch(null);
  h.app.showNotice('New guest generation'); h.selectFiles([importedFile('New guest.md')], 'new-guest-selection.md');
  const before = h.state, notice = feedback(h); gate.reject(new Error('First guest generation failed')); await pending; await h.flush();
  assert.deepEqual(h.state, before); assert.deepEqual(feedback(h), notice); assert.equal(h.nodes.get('file-input').value, 'new-guest-selection.md');
});

test('imports keep valid older batches while only the latest batch owns terminal feedback', async () => {
  const h = await environment(), gate = deferred();
  const older = h.app.importFiles([importedFile('Older first.md', 'Older first source', { gate }), importedFile('Older second.md', 'Older second source')]);
  await h.app.importFiles([importedFile('Newer.md', 'Newer source')]); await h.flush(); const notice = feedback(h);
  assert.match(notice.text, /^1 page has a new home\./); gate.resolve(); await older; await h.flush();
  for (const title of ['Older first', 'Older second', 'Newer']) assert.ok(h.state.documents.some(doc => doc.title === title));
  assert.deepEqual(feedback(h), notice, 'Older valid imports remain useful without replacing the latest summary.');
});

test('imports suppress an older failure after a newer successful batch', async () => {
  const h = await environment(), gate = deferred(), older = h.app.importFiles([importedFile('Obsolete failure.md', '', { gate })]);
  await h.app.importFiles([importedFile('Newer success.md', 'Newer source')]); await h.flush(); const notice = feedback(h);
  gate.reject(new Error('Obsolete import failed')); await older; await h.flush();
  assert.deepEqual(feedback(h), notice); assert.ok(h.state.documents.some(doc => doc.title === 'Newer success'));
});

test('imports suppress older feedback while the newest batch is still reading', async () => {
  const h = await environment(), oldGate = deferred(), newGate = deferred();
  const older = h.app.importFiles([importedFile('Old waiting.md', '', { gate: oldGate })]);
  const latest = h.app.importFiles([importedFile('New waiting.md', 'Newest source', { gate: newGate })]);
  h.app.showNotice('Newest file is still being read'); const notice = feedback(h);
  oldGate.reject(new Error('Old file failed')); await older; await h.flush(); assert.deepEqual(feedback(h), notice);
  newGate.resolve(); await latest; await h.flush(); assert.ok(h.state.documents.some(doc => doc.title === 'New waiting'));
});

test('imports do not supersede a pending batch when an empty selection arrives', async () => {
  const h = await environment(), gate = deferred(), pending = h.app.importFiles([importedFile('Kept pending.md', 'Kept source', { gate })]);
  await h.pick([]); gate.resolve(); await pending; await h.flush();
  assert.ok(h.state.documents.some(doc => doc.title === 'Kept pending')); assert.match(feedback(h).text, /^1 page has a new home\./);
});

test('imports stop advancing the old batch when context changes across the awaited page creation', async () => {
  const h = await environment(), next = importedFile('Must not read next.md'); let transition;
  h.onNextSave(() => queueMicrotask(() => { transition = h.switch(null); }));
  await h.app.importFiles([importedFile('Created before retry.md', 'Source retained before retry'), next]);
  assert.ok(transition, 'The controlled persistence boundary must schedule the actual workspace transition.');
  await transition; await h.flush();
  assert.equal(next.calls.reads, 0); assert.ok(h.state.documents.some(doc => doc.title === 'Created before retry'));
  assert.doesNotMatch(feedback(h).text, /pages? (?:has|have) a new home/);
});

test('imports retain a known device-save failure and export action alongside the current partial result', async () => {
  const original = [page('saved-original')], h = await environment(original), gate = deferred(); h.failSaves();
  const pending = h.app.importFiles([importedFile('Unsaved accepted.md', 'Exact unsaved imported source\r\n'), importedFile('Failed remaining.md', '', { gate })]);
  await h.flush(); assert.equal(h.state.deviceUnsafe, true); assert.equal(h.nodes.get('notice-action').textContent, 'Export page');
  gate.reject(new Error('Authored remaining read failure')); await pending; await h.flush();
  assert.match(feedback(h).text, /1 imported/); assert.match(feedback(h).text, /Failed remaining\.md: Authored remaining read failure/);
  assert.match(feedback(h).text, /storage.*(?:full|unavailable)|could not.*sav|not.*sav/i);
  assert.equal(feedback(h).action, 'Export page'); assert.equal(feedback(h).actionHidden, false); assert.equal(feedback(h).error, true);
  assert.deepEqual(h.records.get('guest'), original); assert.equal(h.unloadBlocked(), true);
  await h.click('notice-action'); assert.equal(h.downloads.length, 1);
  assert.equal(await h.downloads[0].blob.text(), 'Exact unsaved imported source\r\n');
});

test('imports retain the unread-workspace warning and export action alongside count and file errors', async () => {
  const original = [invalidPage()], h = await environment(original), gate = deferred();
  const pending = h.app.importFiles([importedFile('Recovery accepted.md', 'Exact recovery import\r\n'), importedFile('Recovery failed.md', '', { gate })]);
  await h.flush(); assert.ok(h.state.unread.includes('guest'));
  gate.reject(new Error('Authored recovery read failure')); await pending; await h.flush();
  assert.match(feedback(h).text, /1 imported/); assert.match(feedback(h).text, /Recovery failed\.md: Authored recovery read failure/);
  assert.match(feedback(h).text, /(?:drafts|pages).*could not be read|saving.*paused|kept in this tab/i);
  assert.equal(feedback(h).action, 'Export page'); assert.equal(feedback(h).actionHidden, false); assert.equal(feedback(h).error, true);
  protectedSnapshot(h, original); assert.equal(h.nodes.get('recovery-panel').hidden, false);
  await h.click('notice-action'); assert.equal(h.downloads.length, 1);
  assert.equal(await h.downloads[0].blob.text(), 'Exact recovery import\r\n');
});
