import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';

const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);

let moduleNumber = 0;
function memoryStorage() {
  const values = new Map();
  return { values, blocked: false,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (this.blocked) throw new DOMException('Full', 'QuotaExceededError');
      values.set(key, String(value));
    },
  };
}
function databaseBoundary({ manual = false } = {}) {
  const records = new Map(); const waiting = []; const ready = []; const transactions = [];
  let exists = false;
  const database = {
    objectStoreNames: { contains: () => exists },
    createObjectStore(name, options) { assert.equal(name, 'workspaces'); assert.equal(options.keyPath, 'owner'); exists = true; },
    close() {},
    transaction(name, mode) {
      assert.equal(name, 'workspaces');
      const transaction = { mode, error: null,
        objectStore() {
          const request = { result: undefined, error: null };
          const begin = (operation) => {
            transaction.operation = operation;
            queueMicrotask(() => {
              request.result = operation.kind === 'get' ? structuredClone(records.get(operation.owner)) : operation.owner;
              request.onsuccess?.();
              transaction.commit = () => {
                if (operation.kind === 'put') records.set(operation.owner, structuredClone(operation.value));
                transaction.oncomplete?.();
              };
              transaction.abort = () => {
                transaction.error = new DOMException('Full', 'QuotaExceededError'); transaction.onabort?.();
              };
              if (manual) {
                const listener = waiting.shift(); if (listener) listener(transaction); else ready.push(transaction);
              } else transaction.commit();
            });
            return request;
          };
          return { get: (owner) => begin({ kind: 'get', owner }),
            put: (value) => begin({ kind: 'put', owner: value.owner, value: structuredClone(value) }) };
        },
      };
      transactions.push(transaction); return transaction;
    },
  };
  return {
    records, transactions, database,
    factory: { open() {
      const request = { result: database };
      queueMicrotask(() => { if (!exists) request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    } },
    next() { return ready.length ? Promise.resolve(ready.shift()) : new Promise((resolve) => waiting.push(resolve)); },
  };
}
async function environment(t, indexedDB) {
  const names = ['indexedDB', 'localStorage'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const local = memoryStorage();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDB });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  const module = await import(`../public/storage.js?test=${++moduleNumber}`);
  return { ...module, local };
}

test('fallback snapshots copy nested data immediately and isolate workspace owners', async (t) => {
  const store = await environment(t);
  assert.equal(await store.loadWorkspace('guest'), null);
  const pages = [{ id: 'one', markdown: 'original', nested: { revision: 1 } }];
  const saving = store.saveWorkspace('guest', pages);
  pages[0].markdown = 'changed'; pages[0].nested.revision = 2; await saving;
  const loaded = await store.loadWorkspace('guest');
  assert.deepEqual(loaded, [{ id: 'one', markdown: 'original', nested: { revision: 1 } }]);
  loaded[0].markdown = 'local mutation';
  assert.equal((await store.loadWorkspace('guest'))[0].markdown, 'original');
  assert.equal(await store.loadWorkspace('account-b'), null);
});

test('fallback loads wait for queued saves and return the latest committed snapshot', async (t) => {
  const store = await environment(t);
  const first = store.saveWorkspace('guest', [{ markdown: 'one' }]);
  const second = store.saveWorkspace('guest', [{ markdown: 'two' }]);
  const loading = store.loadWorkspace('guest');
  await Promise.all([first, second]);
  assert.deepEqual(await loading, [{ markdown: 'two' }]);
});

test('quota failure rejects persistence, preserves the prior snapshot, and permits an explicit retry', async (t) => {
  const store = await environment(t);
  await store.saveWorkspace('guest', [{ markdown: 'committed' }]);
  store.local.blocked = true;
  const failed = store.saveWorkspace('guest', [{ markdown: 'unsaved' }]);
  const afterFailure = store.loadWorkspace('guest');
  await Promise.all([
    assert.rejects(failed, { code: 'device_storage_full' }),
    assert.rejects(afterFailure, { code: 'device_storage_full' }),
  ]);
  store.local.blocked = false;
  assert.deepEqual(await store.loadWorkspace('guest'), [{ markdown: 'committed' }]);
  await store.saveWorkspace('guest', [{ markdown: 'retried' }]);
  assert.deepEqual(await store.loadWorkspace('guest'), [{ markdown: 'retried' }]);
});

test('an unavailable IndexedDB API falls back to the existing localStorage format', async (t) => {
  const store = await environment(t, { open() { throw new DOMException('Blocked', 'SecurityError'); } });
  store.local.setItem('still.pages.guest', '[{"markdown":"legacy draft"}]');
  assert.deepEqual(await store.loadWorkspace('guest'), [{ markdown: 'legacy draft' }]);
  await store.saveWorkspace('guest', [{ markdown: 'new fallback draft' }]);
  assert.equal(JSON.parse(store.local.getItem('still.pages.guest'))[0].markdown, 'new fallback draft');
});

test('corrupt legacy snapshots fail visibly instead of being treated as an empty workspace', async (t) => {
  const store = await environment(t); store.local.setItem('still.pages.guest', '{broken');
  await assert.rejects(store.loadWorkspace('guest'), { code: 'device_storage_failed' });
  assert.equal(store.local.getItem('still.pages.guest'), '{broken');
});

test('legacy pages migrate durably to IndexedDB and subsequent loads do not reuse stale localStorage', async (t) => {
  const idb = databaseBoundary(); const store = await environment(t, idb.factory);
  store.local.setItem('still.pages.guest', '[{"markdown":"legacy"}]');
  assert.deepEqual(await store.loadWorkspace('guest'), [{ markdown: 'legacy' }]);
  assert.deepEqual(idb.records.get('guest').documents, [{ markdown: 'legacy' }]);
  assert.equal(store.local.getItem('still.pages.idb.guest'), '1');
  await store.saveWorkspace('guest', [{ markdown: 'database revision' }]);
  assert.deepEqual(await store.loadWorkspace('guest'), [{ markdown: 'database revision' }]);
  assert.equal(JSON.parse(store.local.getItem('still.pages.guest'))[0].markdown, 'legacy');
});

test('IndexedDB saves await commit and serialize later writes and reads behind it', async (t) => {
  const idb = databaseBoundary({ manual: true }); const store = await environment(t, idb.factory);
  let firstDone = false; let secondDone = false;
  const input = [{ markdown: 'one' }];
  const first = store.saveWorkspace('guest', input).then(() => { firstDone = true; });
  input[0].markdown = 'mutated after save call';
  const second = store.saveWorkspace('guest', [{ markdown: 'two' }]).then(() => { secondDone = true; });
  const loading = store.loadWorkspace('guest');
  const firstTransaction = await idb.next();
  assert.equal(firstDone, false); assert.equal(secondDone, false); assert.equal(idb.transactions.length, 1);
  firstTransaction.commit(); await first;
  assert.equal(idb.records.get('guest').documents[0].markdown, 'one');
  const secondTransaction = await idb.next(); assert.equal(secondDone, false);
  secondTransaction.commit(); await second;
  const reading = await idb.next(); assert.equal(reading.mode, 'readonly'); reading.commit();
  assert.deepEqual(await loading, [{ markdown: 'two' }]);
});

test('IndexedDB transaction abort rejects the save and keeps the previously committed snapshot', async (t) => {
  const idb = databaseBoundary({ manual: true }); const store = await environment(t, idb.factory);
  idb.records.set('guest', { owner: 'guest', documents: [{ markdown: 'committed' }] });
  const saving = store.saveWorkspace('guest', [{ markdown: 'must not replace committed data' }]);
  const rejected = assert.rejects(saving, { code: 'device_storage_full' });
  const transaction = await idb.next(); transaction.abort(); await rejected;
  assert.equal(idb.records.get('guest').documents[0].markdown, 'committed');
});

test('a migrated workspace refuses stale fallback reads and writes while IndexedDB is unavailable', async (t) => {
  const store = await environment(t);
  store.local.setItem('still.pages.idb.guest', '1');
  store.local.setItem('still.pages.guest', '[{"markdown":"stale backup"}]');
  await assert.rejects(store.loadWorkspace('guest'), { code: 'device_database_unavailable' });
  await assert.rejects(store.saveWorkspace('guest', [{ markdown: 'replacement' }]), { code: 'device_database_unavailable' });
  assert.equal(JSON.parse(store.local.getItem('still.pages.guest'))[0].markdown, 'stale backup');
});
