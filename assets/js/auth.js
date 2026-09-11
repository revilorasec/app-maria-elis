const CONFIG_KEY = 'maria-onedrive-config';
export const GRAPH_SCOPES = ['User.Read', 'Files.ReadWrite'];
const DEFAULT_ONEDRIVE_CONFIG = Object.freeze({
  clientId: '6b8bb756-f14c-493c-bc55-6966f75a18c4',
  tenantId: '911e1aee-070e-421b-ae71-439f01c2263e',
  folderName: '(APP MARIA ELIS)'
});

let client = null;
let activeAccount = null;

export function loadOneDriveConfig() {
  // Os identificadores sao publicos e pertencem exclusivamente a este app.
  // A copia local apenas migra aparelhos que usavam a antiga tela tecnica.
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(DEFAULT_ONEDRIVE_CONFIG)); }
  catch { /* O login continua funcionando sem armazenamento local. */ }
  return { ...DEFAULT_ONEDRIVE_CONFIG };
}

export async function initializeMicrosoftSession() {
  const config = loadOneDriveConfig();
  if (!config?.clientId) return { config: null, account: null };

  await ensureMsal();
  client = new window.msal.PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri: `${window.location.origin}${window.location.pathname}`,
      postLogoutRedirectUri: `${window.location.origin}${window.location.pathname}`
    },
    cache: { cacheLocation: 'localStorage' }
  });

  const redirect = await client.handleRedirectPromise();
  if (redirect?.account) client.setActiveAccount(redirect.account);
  activeAccount = client.getActiveAccount() || client.getAllAccounts()[0] || null;
  if (activeAccount) client.setActiveAccount(activeAccount);
  return { config, account: activeAccount };
}

export async function signInMicrosoft() {
  if (!client) await initializeMicrosoftSession();
  if (!client) throw new Error('Não foi possível iniciar a conexão com a Microsoft.');
  await client.loginRedirect({ scopes: GRAPH_SCOPES });
}

export async function signOutMicrosoft() {
  if (!client) return;
  await client.logoutRedirect({ account: activeAccount || undefined });
}

export function getMicrosoftAccount() {
  return activeAccount;
}

export async function getAccessToken() {
  if (!client || !activeAccount) throw new Error('Entre com sua conta Microsoft para continuar.');
  try {
    return (await client.acquireTokenSilent({ scopes: GRAPH_SCOPES, account: activeAccount })).accessToken;
  } catch (error) {
    await client.acquireTokenRedirect({ scopes: GRAPH_SCOPES, account: activeAccount });
    throw error;
  }
}

function ensureMsal() {
  if (!window.msal?.PublicClientApplication) {
    throw new Error('A biblioteca de login Microsoft não foi carregada. Verifique a conexão e recarregue a página.');
  }
}
