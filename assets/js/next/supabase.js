import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js?v=19';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.8/+esm';

const SESSION_STORAGE_KEY = 'maria-elis-direct-session-v1';
const REQUEST_TIMEOUT_MS = 15000;
const REFRESH_MARGIN_SECONDS = 60;

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session?.access_token || !session?.user?.id) return null;
    return session;
  } catch {
    return null;
  }
}

function writeStoredSession(session) {
  if (!session) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function normalizeSession(payload) {
  const expiresIn = Number(payload?.expires_in || 3600);
  const expiresAt = Number(payload?.expires_at || Math.floor(Date.now() / 1000) + expiresIn);
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: expiresIn,
    expires_at: expiresAt,
    token_type: payload.token_type || 'bearer',
    user: payload.user,
  };
}

async function fetchWithTimeout(url, options = {}, label = 'A operação') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${label} excedeu ${REQUEST_TIMEOUT_MS / 1000} segundos.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(accessToken = '') {
  return {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    'content-type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

function buildClient(accessToken = '') {
  return createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: accessToken
        ? { headers: { Authorization: `Bearer ${accessToken}` } }
        : {},
    },
  );
}

export let supabase = buildClient(readStoredSession()?.access_token || '');

function activateSession(session) {
  writeStoredSession(session);
  supabase = buildClient(session?.access_token || '');
}

async function refreshSession(refreshToken) {
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
    'A renovação da sessão',
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token || !payload?.user) {
    activateSession(null);
    return null;
  }

  const session = normalizeSession(payload);
  activateSession(session);
  return session;
}

export async function signInWithPin(email, pin) {
  try {
    const response = await fetchWithTimeout(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          email: String(email || '').trim().toLowerCase(),
          password: String(pin || ''),
        }),
      },
      'O login',
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.access_token || !payload?.user) {
      const message = payload?.msg || payload?.message || payload?.error_description || 'E-mail ou PIN inválido.';
      return {
        data: { session: null, user: null },
        error: new Error(message),
      };
    }

    const session = normalizeSession(payload);
    activateSession(session);

    return {
      data: { session, user: session.user },
      error: null,
    };
  } catch (error) {
    return {
      data: { session: null, user: null },
      error,
    };
  }
}

export async function signOut() {
  const session = readStoredSession();

  try {
    if (session?.access_token) {
      await fetchWithTimeout(
        `${SUPABASE_URL}/auth/v1/logout`,
        {
          method: 'POST',
          headers: authHeaders(session.access_token),
          body: '{}',
        },
        'O encerramento da sessão',
      );
    }
  } catch (error) {
    console.warn('A sessão remota não pôde ser encerrada, mas a sessão local será removida.', error);
  } finally {
    activateSession(null);
  }
}

export async function currentSession() {
  const session = readStoredSession();
  if (!session) return null;

  const expiresAt = Number(session.expires_at || 0);
  const now = Math.floor(Date.now() / 1000);

  if (expiresAt > now + REFRESH_MARGIN_SECONDS) {
    return session;
  }

  if (!session.refresh_token) {
    activateSession(null);
    return null;
  }

  return refreshSession(session.refresh_token);
}
