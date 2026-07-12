const DEVICE_KEY = 'maria-onedrive-device-access-v1';
const MAX_ATTEMPTS = 5;
const BLOCK_MINUTES = 15;

export function getDeviceBinding() {
  try {
    const value = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
    return value && typeof value === 'object' && value.personId ? value : null;
  } catch {
    localStorage.removeItem(DEVICE_KEY);
    return null;
  }
}

export function saveDeviceBinding(value) {
  const current = getDeviceBinding() || {};
  const next = {
    ...current,
    ...value,
    deviceId: current.deviceId || crypto.randomUUID(),
    lockAfterMinutes: clampMinutes(value.lockAfterMinutes ?? current.lockAfterMinutes ?? 10),
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(DEVICE_KEY, JSON.stringify(next));
  return next;
}

export function clearDeviceBinding() {
  localStorage.removeItem(DEVICE_KEY);
}

export function setDeviceLocked(locked) {
  const binding = getDeviceBinding();
  return binding ? saveDeviceBinding({ locked: Boolean(locked), lockedAt: locked ? new Date().toISOString() : null }) : null;
}

export function isAttemptBlocked(binding, scope = 'unlock') {
  const until = Date.parse(binding?.[`${scope}BlockedUntil`] || '');
  return Number.isFinite(until) && until > Date.now();
}

export function remainingBlockMinutes(binding, scope = 'unlock') {
  const until = Date.parse(binding?.[`${scope}BlockedUntil`] || '');
  return Number.isFinite(until) ? Math.max(1, Math.ceil((until - Date.now()) / 60_000)) : 0;
}

export function registerFailedAttempt(scope = 'unlock') {
  const binding = getDeviceBinding();
  if (!binding) return null;
  const attemptsKey = `${scope}FailedAttempts`;
  const attempts = Number(binding[attemptsKey] || 0) + 1;
  const blocked = attempts >= MAX_ATTEMPTS;
  return saveDeviceBinding({
    [attemptsKey]: blocked ? 0 : attempts,
    [`${scope}BlockedUntil`]: blocked ? new Date(Date.now() + BLOCK_MINUTES * 60_000).toISOString() : null,
    lastFailedAttemptAt: new Date().toISOString()
  });
}

export function clearFailedAttempts(scope = 'unlock') {
  const binding = getDeviceBinding();
  return binding ? saveDeviceBinding({ [`${scope}FailedAttempts`]: 0, [`${scope}BlockedUntil`]: null }) : null;
}

export function validPin(pin) {
  return /^\d{4,6}$/.test(String(pin || ''));
}

export async function createPinHash(pin) {
  if (!validPin(pin)) throw new Error('Use um PIN numérico de 4 a 6 dígitos.');
  if (!globalThis.crypto?.subtle) throw new Error('Este navegador não oferece o recurso de segurança necessário para salvar o PIN.');
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('');
  const digest = await digestPin(pin, salt);
  return { algorithm: 'SHA-256', salt, digest, createdAt: new Date().toISOString() };
}

export async function verifyPin(pin, pinHash) {
  if (!validPin(pin) || !pinHash?.salt || !pinHash?.digest) return false;
  const digest = await digestPin(pin, pinHash.salt);
  return constantTimeEqual(digest, String(pinHash.digest));
}

async function digestPin(pin, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${pin}`);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function clampMinutes(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) ? Math.max(1, Math.min(120, Math.round(minutes))) : 10;
}
