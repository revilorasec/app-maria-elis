const CACHE_KEY = 'maria-onedrive-cache-v1';
let state;
let saveRemote = null;
let saveError = null;
let syncQueue = Promise.resolve();

export async function loadData(initialData) {
  if (initialData) {
    state = initialData;
    persistLocal();
    return state;
  }
  if (state) return state;
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      state = JSON.parse(cached);
      return state;
    } catch {
      localStorage.removeItem(CACHE_KEY);
    }
  }
  const response = await fetch('data/data.sample.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Não foi possível carregar a estrutura inicial do app.');
  state = hydrateForToday(await response.json());
  persistLocal();
  return state;
}

export function setPersistence({ save, onError } = {}) {
  saveRemote = typeof save === 'function' ? save : null;
  saveError = typeof onError === 'function' ? onError : null;
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
  const item = { id: record.id || (collection + '-' + crypto.randomUUID()), ...record, createdBy: userId, createdAt: new Date().toISOString() };
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

export async function flushPersistence() {
  await syncQueue;
}

export function resetLocalCache() {
  localStorage.removeItem(CACHE_KEY);
  state = undefined;
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
  persistLocal();
  if (!saveRemote) return;
  const snapshot = structuredClone(state);
  syncQueue = syncQueue
    .catch(() => {})
    .then(() => saveRemote(snapshot))
    .catch((error) => { if (saveError) saveError(error); });
}

function persistLocal() {
  localStorage.setItem(CACHE_KEY, JSON.stringify(state));
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
