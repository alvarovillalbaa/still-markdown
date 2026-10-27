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
  const scriptedReads = new Map(), remote = new Map(), urls = new Map();
  const nodes = new Map(), timers = new Map(), windowListeners = new Map();
  let sequence = 0, timerId = 0, app;
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
  // Baseline source uses the current harmless platform boundary. New controls
  // are present but have no callback until the actual new app registers one.
  for (const id of ['recovery-panel', 'export-recovery', 'retry-workspace']) {
    if (!nodes.has(id)) { const element = node('div', id); element.hidden = true; nodes.set(id, element); }
  }
  const document = {
    body: node('body'), title: '', activeElement: null,
    getElementById(id) { assert.ok(nodes.has(id), 'Unmodeled app element: ' + id); return nodes.get(id); },
    createElement: (tag) => node(tag), addEventListener() {},
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
      writes.push({ owner: user, documents: copy(documents) }); records.set(user, copy(documents));
    },
  });
  const stripped = source.replace(/^import [^\n]+;\s*$/gm, '');
  const adapter = `
    return { cloud, loadWorkspace, persist, newPage, pageChanged, current, selectPage, showNotice,
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
