const DATABASE = 'still-workspaces';
const STORE = 'workspaces';
const operations = new Map();
let databasePromise;

export class StorageError extends Error {
  constructor(message, code = 'device_storage_failed') {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

function failure(error, action) {
  if (error instanceof StorageError) return error;
  if (error?.name === 'QuotaExceededError') {
    return new StorageError('Device storage is full. Export unsaved pages before leaving.', 'device_storage_full');
  }
  if (error?.name === 'SecurityError') {
    return new StorageError('This browser is blocking device storage. Export unsaved pages before leaving.', 'device_storage_blocked');
  }
  return new StorageError(`Could not ${action} pages on this device. Export unsaved pages before leaving.`);
}

function validateOwner(owner) {
  if (typeof owner !== 'string' || !owner || owner.length > 128) {
    throw new StorageError('This workspace has an invalid owner.', 'invalid_workspace');
  }
}

function storage() {
  try {
    if (!globalThis.localStorage) throw new Error('Unavailable');
    return globalThis.localStorage;
  } catch (error) { throw failure(error, 'save'); }
}

function legacyKey(owner) { return `still.pages.${owner}`; }
function migratedKey(owner) { return `still.pages.idb.${owner}`; }

function readLegacy(owner, fallback = false) {
  const local = storage();
  try {
    // A stale pre-migration copy must not replace a newer IndexedDB workspace.
    if (fallback && local.getItem(migratedKey(owner)) === '1') {
      throw new StorageError('Your pages are in the browser database, which is temporarily unavailable. Reopen Still in this browser to recover them.', 'device_database_unavailable');
    }
    const value = local.getItem(legacyKey(owner));
    if (value === null) return null;
    const documents = JSON.parse(value);
    if (!Array.isArray(documents)) throw new Error('Invalid workspace snapshot');
    return documents;
  } catch (error) { throw failure(error, 'load'); }
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    let request;
    try {
      if (!globalThis.indexedDB) { resolve(null); return; }
      request = globalThis.indexedDB.open(DATABASE, 1);
    } catch { resolve(null); return; }
    let settled = false;
    const finish = (database) => {
      if (settled) { database?.close(); return; }
      settled = true;
      clearTimeout(timeout);
      resolve(database);
    };
    const timeout = setTimeout(() => finish(null), 4000);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'owner' });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = null; };
      database.onclose = () => { databasePromise = null; };
      finish(database);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
  return databasePromise;
}

function transact(database, mode, operation) {
  return new Promise((resolve, reject) => {
    let transaction;
    let request;
    try {
      transaction = database.transaction(STORE, mode);
      request = operation(transaction.objectStore(STORE));
    } catch (error) { reject(failure(error, mode === 'readwrite' ? 'save' : 'load')); return; }
    // Request success alone does not establish durability; wait for commit.
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(failure(transaction.error || request.error, mode === 'readwrite' ? 'save' : 'load'));
    transaction.onerror = () => { /* Abort is the final transaction result. */ };
  });
}

function enqueue(owner, operation, allowRetry) {
  const previous = operations.get(owner) || Promise.resolve();
  const promise = (allowRetry ? previous.catch(() => {}) : previous).then(operation);
  operations.set(owner, promise);
  const release = () => { if (operations.get(owner) === promise) operations.delete(owner); };
  promise.then(release, release);
  return promise;
}

async function writeSnapshot(owner, documents, database) {
  if (database) {
    await transact(database, 'readwrite', (store) => store.put({ owner, documents, updated_at: Date.now() }));
    // Only a tiny marker goes to localStorage; full pages live in IndexedDB.
    try { storage().setItem(migratedKey(owner), '1'); } catch { /* The IndexedDB commit is already durable. */ }
    return;
  }
  const local = storage();
  try {
    if (local.getItem(migratedKey(owner)) === '1') {
      throw new StorageError('The browser database is unavailable. Export your draft before leaving, then reopen Still to restore device saving.', 'device_database_unavailable');
    }
    local.setItem(legacyKey(owner), JSON.stringify(documents));
  } catch (error) { throw failure(error, 'save'); }
}

/** Load the latest committed account snapshot, after earlier queued saves. */
export async function loadWorkspace(owner) {
  validateOwner(owner);
  return enqueue(owner, async () => {
    const database = await openDatabase();
    if (!database) return readLegacy(owner, true);
    const record = await transact(database, 'readonly', (store) => store.get(owner));
    if (record) {
      if (!Array.isArray(record.documents)) throw new StorageError('The saved workspace is unreadable. Keep any open drafts and export them.', 'invalid_workspace');
      return structuredClone(record.documents);
    }
    let legacy;
    try { legacy = readLegacy(owner); }
    catch (error) {
      // IndexedDB can be available when the legacy localStorage API is blocked.
      if (error.code === 'device_storage_blocked' || !globalThis.localStorage) return null;
      throw error;
    }
    if (legacy === null) return null;
    const snapshot = structuredClone(legacy);
    await writeSnapshot(owner, snapshot, database);
    return structuredClone(snapshot);
  }, false);
}

/** Snapshot immediately, then serialize durable commits separately for each owner. */
export async function saveWorkspace(owner, documents) {
  validateOwner(owner);
  if (!Array.isArray(documents)) throw new StorageError('Pages must be a workspace list.', 'invalid_workspace');
  let snapshot;
  try { snapshot = structuredClone(documents); }
  catch (error) { throw failure(error, 'copy'); }
  return enqueue(owner, async () => writeSnapshot(owner, snapshot, await openDatabase()), true);
}
