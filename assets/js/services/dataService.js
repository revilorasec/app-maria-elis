const LEGACY_CACHE_KEY = 'maria-onedrive-cache-v1';
const CACHE_PREFIX = 'maria-onedrive-cache-v2:';

let namespace = null;
let baseVersion = null;
let state;
let dirty = false;
let revision = 0;
let contextVersion = 0;
let saveRemote = null;
let saveError = null;
let syncQueue = Promise.resolve();

export function setDataNamespace(nextNamespace) {
  const normalized = normalizeNamespace(nextNamespace);
  localStorage.removeItem(LEGACY_CACHE_KEY);
  if (normalized === namespace) return normalized;

  namespace = normalized;
  baseVersion = null;
  state = undefined;
  dirty = false;
  revision = 0;
  contextVersion += 1;
  saveRemote = null;
  saveError = null;
  return normalized;
}

export function preserveLegacyPendingNamespace(legacyNamespace) {
  const oldNamespace = normalizeNamespace(legacyNamespace);
  const oldKey = CACHE_PREFIX + encodeURIComponent(oldNamespace);
  const newKey = currentCacheKey();
  if (!newKey || oldKey === newKey || localStorage.getItem(newKey)) return false;
  const raw = localStorage.getItem(oldKey);
  if (!raw) return false;
  try {
    const envelope = JSON.parse(raw);
    if (!envelope?.state || envelope.dirty !== true) return false;
    localStorage.setItem(newKey, JSON.stringify({ ...envelope, baseVersion: null, requiresReview: true, migratedFromNamespace: oldNamespace, updatedAt: new Date().toISOString() }));
    localStorage.removeItem(oldKey);
    return true;
  } catch {
    return false;
  }
}
export async function loadInitialData() {
  const response = await fetch('data/data.sample.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Não foi possível carregar a estrutura inicial do app.');
  return hydrateForToday(await response.json());
}

export async function loadData(initialData, { preferPending = false, markDirty = false } = {}) {
  localStorage.removeItem(LEGACY_CACHE_KEY);
  const cached = readLocalEnvelope();

  if (initialData) {
    if (preferPending && cached?.dirty) {
      state = cached.state;
      baseVersion = cached.baseVersion || baseVersion;
      dirty = true;
      revision += 1;
      return state;
    }

    state = initialData;
    dirty = Boolean(markDirty);
    revision += 1;
    persistLocal();
    return state;
  }

  if (state) return state;
  if (cached) {
    state = cached.state;
    baseVersion = cached.baseVersion || null;
    dirty = cached.dirty;
    revision += 1;
    return state;
  }

  state = await loadInitialData();
  dirty = false;
  revision += 1;
  persistLocal();
  return state;
}

export function getPendingChanges() {
  const cached = readLocalEnvelope();
  return cached?.dirty ? structuredClone(cached) : null;
}

export function setDataBaseVersion(version) {
  baseVersion = String(version || '');
  if (state) persistLocal();
  return baseVersion;
}

export function setPersistence({ save, onError } = {}) {
  saveRemote = typeof save === 'function' ? save : null;
  saveError = typeof onError === 'function' ? onError : null;
  if (saveRemote && dirty && state) queueRemoteSave();
}

export function getData() {
  if (!state) throw new Error('Os dados ainda não foram carregados.');
  return state;
}

export function saveData(nextState) {
  state = nextState;
  persist();
  return state;
}

export function addRecord(collection, record, userId) {
  if (!Array.isArray(state?.[collection])) state[collection] = [];
  const item = { id: record.id || (collection + '-' + crypto.randomUUID()), ...record, createdBy: record.createdBy || userId, createdAt: record.createdAt || new Date().toISOString() };
  state[collection].unshift(item);
  appendAudit('create', collection, item.id, userId, null, item);
  persist();
  return item;
}

export function updateRecord(collection, id, updates, userId) {
  const index = state?.[collection]?.findIndex((item) => item.id === id) ?? -1;
  if (index === -1) throw new Error('Registro não encontrado.');
  const oldValue = state[collection][index];
  state[collection][index] = { ...oldValue, ...updates, updatedAt: new Date().toISOString() };
  appendAudit('update', collection, id, userId, oldValue, state[collection][index]);
  persist();
  return state[collection][index];
}

export function removeRecord(collection, id, userId) {
  const index = state?.[collection]?.findIndex((item) => item.id === id) ?? -1;
  if (index === -1) throw new Error('Registro não encontrado.');
  const [removed] = state[collection].splice(index, 1);
  appendAudit('delete', collection, id, userId, removed, null);
  persist();
  return removed;
}

export async function flushPersistence() {
  await syncQueue;
}

export function hasPendingChanges() {
  if (dirty) return true;
  return Boolean(readLocalEnvelope()?.dirty);
}

export function resetLocalCache() {
  const key = currentCacheKey();
  if (key) localStorage.removeItem(key);
  localStorage.removeItem(LEGACY_CACHE_KEY);
  state = undefined;
  baseVersion = null;
  dirty = false;
  revision += 1;
  contextVersion += 1;
}

function appendAudit(action, entityType, entityId, userId, oldValue, newValue) {
  if (!Array.isArray(state.auditLog)) state.auditLog = [];
  state.auditLog.unshift({
    id: 'audit-' + crypto.randomUUID(),
    userId,
    action,
    entityType,
    entityId,
    oldValue: oldValue ? '[dados alterados]' : null,
    newValue: newValue ? '[dados registrados]' : null,
    createdAt: new Date().toISOString()
  });
}

function persist() {
  dirty = true;
  revision += 1;
  persistLocal();
  if (saveRemote) queueRemoteSave();
}

function queueRemoteSave() {
  const snapshot = structuredClone(state);
  const snapshotRevision = revision;
  const snapshotContext = contextVersion;
  const snapshotNamespace = namespace;
  const remoteSaver = saveRemote;
  const errorHandler = saveError;

  syncQueue = syncQueue
    .catch(() => {})
    .then(() => remoteSaver(snapshot))
    .then(() => {
      if (snapshotContext !== contextVersion || snapshotNamespace !== namespace || snapshotRevision !== revision) return;
      dirty = false;
      persistLocal();
    })
    .catch((error) => {
      if (snapshotContext === contextVersion && snapshotNamespace === namespace) {
        dirty = true;
        persistLocal();
      }
      if (errorHandler) errorHandler(error);
    });
}

function persistLocal() {
  const key = currentCacheKey();
  if (!key || !state) return;
  const envelope = { state, dirty, baseVersion, updatedAt: new Date().toISOString() };
  localStorage.setItem(key, JSON.stringify(envelope));
}

function readLocalEnvelope() {
  const key = currentCacheKey();
  if (!key) return null;
  const cached = localStorage.getItem(key);
  if (!cached) return null;
  try {
    const envelope = JSON.parse(cached);
    if (!envelope || typeof envelope !== 'object' || !envelope.state || typeof envelope.dirty !== 'boolean') {
      localStorage.removeItem(key);
      return null;
    }
    return envelope;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

function currentCacheKey() {
  return namespace ? CACHE_PREFIX + encodeURIComponent(namespace) : null;
}

function normalizeNamespace(value) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error('Não foi possível identificar a conta e a pasta de dados para criar o cache local.');
  return normalized;
}

function hydrateForToday(data) {
  const oldDate = '2026-07-09';
  const today = localDate();
  const shift = (value) => typeof value === 'string' ? value.replace(oldDate, today) : value;
  for (const collection of ['dailyInstructions', 'dailyTasks', 'dailyPhotos', 'dailyConfirmations', 'dailyComments', 'dailyLogs']) {
    if (!Array.isArray(data[collection])) data[collection] = [];
    data[collection] = data[collection].map((item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, shift(value)])));
  }
  return data;
}

export function localDate() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}