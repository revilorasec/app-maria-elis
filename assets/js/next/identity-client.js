import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js?v=19';
import { supabase, currentSession } from './supabase.js?v=19';

const endpoint = `${SUPABASE_URL}/functions/v1/identity-gateway`;

export async function identityRequest(action, body = {}) {
  const session = await currentSession();
  if (!session) throw new Error('Sessão expirada.');
  const response = await fetch(`${endpoint}?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || 'Ação administrativa não autorizada.');
  return data;
}

export const listUsers = () => identityRequest('list-users');
export const createUser = (input) => identityRequest('create-user', input);
export const resetUserPin = (userId, pin) => identityRequest('update-pin', { userId, pin });
export const setUserBlock = (userId, blockedUntil) => identityRequest('block-user', { userId, blockedUntil });
export const unblockUser = (userId) => identityRequest('unblock-user', { userId });
export const setMyPin = (pin) => identityRequest('set-my-pin', { pin });


export const updateUser = (input) => identityRequest('update-user', input);

