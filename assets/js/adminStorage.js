import { ensureFolder, getFileMetadata, graphFetch, graphJson, itemPath, putFile } from './graph.js?v=16';

export const DEFAULT_ADMIN_FOLDER = '(APP MARIA ELIS - ADMIN)';

let adminRoot = null;
let adminEtag = null;
let adminData = null;

export async function connectAdminArea({ folderName = DEFAULT_ADMIN_FOLDER, create = false } = {}) {
  const listing = await graphJson('/me/drive/root/children?$select=id,name,folder,remoteItem,parentReference&$top=999');
  let item = listing.value?.find((candidate) => candidate.name === folderName && (candidate.folder || candidate.remoteItem?.folder));
  if (!item && !create) {
    const error = new Error('A área administrativa ainda não foi criada.');
    error.code = 'ADMIN_FOLDER_NOT_FOUND';
    throw error;
  }
  if (!item) {
    item = await graphJson('/me/drive/root/children', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })
    });
  }
  const remote = item.remoteItem;
  adminRoot = remote
    ? { driveId: remote.parentReference.driveId, itemId: remote.id }
    : { driveId: item.parentReference.driveId, itemId: item.id };
  adminEtag = null;
  adminData = null;
  await Promise.all(['Documentos', 'Config'].map((folder) => ensureFolder(adminRoot, folder)));
  return loadAdminData();
}

export async function loadAdminData() {
  assertAdminRoot();
  try {
    const metadata = await getFileMetadata(adminRoot, 'dados_admin.json');
    const response = await graphFetch(itemPath(adminRoot, 'dados_admin.json') + '/content');
    if (!response.ok) throw new Error('Falha ao ler dados_admin.json (' + response.status + ').');
    adminEtag = metadata.eTag;
    adminData = normalizeAdminData(JSON.parse(await response.text()));
    return adminData;
  } catch (error) {
    if (error.status !== 404) throw error;
    adminData = normalizeAdminData({});
    return saveAdminData(adminData);
  }
}

export async function saveAdminData(nextData) {
  assertAdminRoot();
  const next = normalizeAdminData(structuredClone(nextData));
  next.updatedAt = new Date().toISOString();
  const body = new Blob([JSON.stringify(next, null, 2)], { type: 'application/json' });
  try {
    const result = await putFile(adminRoot, 'dados_admin.json', body, 'application/json', adminEtag);
    adminEtag = result.eTag;
    adminData = next;
    return next;
  } catch (error) {
    if (error.status === 412) throw new Error('Os dados administrativos foram alterados em outro aparelho. Reabra antes de salvar.');
    throw error;
  }
}

export async function uploadAdminFile(relativePath, blob, mimeType) {
  assertAdminRoot();
  return putFile(adminRoot, relativePath, blob, mimeType);
}

export async function deleteAdminPath(relativePath) {
  assertAdminRoot();
  const response = await graphFetch(itemPath(adminRoot, relativePath), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`Não foi possível excluir o arquivo administrativo (${response.status}).`);
  return true;
}

export async function getAdminFileUrl(relativePath) {
  assertAdminRoot();
  return (await getFileMetadata(adminRoot, relativePath)).webUrl;
}

export function isAdminAreaConnected() {
  return Boolean(adminRoot && adminData);
}

function normalizeAdminData(value) {
  return {
    schemaVersion: 1,
    caregivers: value?.caregivers && typeof value.caregivers === 'object' ? value.caregivers : {},
    backupPrivacyScanAt: value?.backupPrivacyScanAt || null,
    updatedAt: value?.updatedAt || null
  };
}

function assertAdminRoot() {
  if (!adminRoot) throw new Error('Ative a área administrativa antes de salvar dados restritos.');
}