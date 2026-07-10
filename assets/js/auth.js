const CONFIG_KEY = 'maria-onedrive-config';
const MSAL_SOURCES = [
  'https://alcdn.msauth.net/browser/2.38.3/js/msal-browser.min.js',
  'https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.4/lib/msal-browser.min.js'
];

export const GRAPH_SCOPES = ['User.Read', 'Files.ReadWrite'];

let client = null;
let activeAccount = null;

export function loadOneDriveConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); }
  catch { return null; }
}

export function saveOneDriveConfig({ clientId, tenantId, folderName }) {
  const config = {
    clientId: String(clientId || '').trim(),
    tenantId: String(tenantId || 'organizations').trim() || 'organizations',
    folderName: String(folderName || '(APP MARIA ELIS)').trim() || '(APP MARIA ELIS)'
  };
  if (!config.clientId) throw new Error('Informe o ID do aplicativo cliente.');
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  return config;
}

export function clearOneDriveConfig() {
  localStorage.removeItem(CONFIG_KEY);
  client = null;
  activeAccount = null;
}

export async function initializeMicrosoftSession() {
  const config = loadOneDriveConfig();
  if (!config?.clientId) return { config: null, account: null };

  await ensureMsal();
  client = new window.msal.PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri: `${location.origin}${location.pathname}`
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
  if (!client) throw new Error('Salve a configuração antes de entrar.');
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

async function ensureMsal() {
  if (window.msal?.PublicClientApplication) return;
  let lastError;
  for (const src of MSAL_SOURCES) {
    try {
      await loadScript(src);
      if (window.msal?.PublicClientApplication) return;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('Não foi possível carregar o login Microsoft.');
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return existing.dataset.loaded === 'true' ? resolve() : existing.addEventListener('load', resolve, { once: true });
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
    script.onerror = () => reject(new Error('Falha ao carregar MSAL. Verifique a conexão.'));
    document.head.append(script);
  });
}
