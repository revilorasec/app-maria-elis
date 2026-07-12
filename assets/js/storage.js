import { ensureFolder, getFileMetadata, graphFetch, graphJson, itemPath, putFile, resolveRootFolder } from './graph.js?v=16';

const LEGACY_BACKUP_KEY = 'maria-onedrive-last-backup';
const BACKUP_KEY_PREFIX = 'maria-onedrive-last-backup:';

let root = null;
let dbEtag = null;
let rawSnapshot = null;

export async function connectOneDrive(folderName) {
  root = null;
  dbEtag = null;
  rawSnapshot = null;
  root = await resolveRootFolder(folderName);
  localStorage.removeItem(LEGACY_BACKUP_KEY);
  await Promise.all(['Backup', 'Fotos', 'Anexos', 'Config'].map((folder) => ensureFolder(root, folder)));
  return root;
}

export function getStorageIdentity() {
  assertRoot();
  return `${root.driveId}:${root.itemId}`;
}

export function getDBVersion() {
  assertRoot();
  return dbEtag || '';
}

export async function loadDB(initialData) {
  assertRoot();
  try {
    const meta = await getFileMetadata(root, 'dados.json');
    const response = await graphFetch(`${itemPath(root, 'dados.json')}/content`);
    if (!response.ok) throw new Error(`Falha ao ler dados.json (${response.status}).`);
    rawSnapshot = await response.text();
    dbEtag = meta.eTag;
    return JSON.parse(rawSnapshot);
  } catch (error) {
    if (error.status !== 404) throw error;
    const first = structuredClone(initialData);
    return saveDB(first, { skipBackup: true });
  }
}

export async function saveDB(data, { skipBackup = false } = {}) {
  assertRoot();
  if (!skipBackup && rawSnapshot) await backupDB();
  const next = structuredClone(data);
  next.meta = { ...(next.meta || {}), updatedAt: new Date().toISOString(), lastBackupAt: localStorage.getItem(backupStorageKey()) || null };
  const body = JSON.stringify(next, null, 2);
  const file = new Blob([body], { type: 'application/json' });
  try {
    const result = await putFile(root, 'dados.json', file, 'application/json', dbEtag);
    dbEtag = result.eTag;
    rawSnapshot = body;
    return next;
  } catch (error) {
    if (error.status === 412) throw new Error('Os dados foram alterados por outra pessoa. Recarregue antes de salvar novamente.');
    throw error;
  }
}

export async function backupDB() {
  assertRoot();
  const day = new Date().toISOString().slice(0, 10);
  const backupKey = backupStorageKey();
  if (localStorage.getItem(backupKey) === day || !rawSnapshot) return false;
  await putFile(root, `Backup/dados_${day}.json`, new Blob([rawSnapshot], { type: 'application/json' }), 'application/json');
  localStorage.setItem(backupKey, day);
  return true;
}

export async function restoreDB(relativePath) {
  return readJsonFile(relativePath);
}

export async function uploadFile(relativePath, blob, mimeType) {
  assertRoot();
  return putFile(root, relativePath, blob, mimeType);
}

export async function downloadFile(relativePath) {
  assertRoot();
  const response = await graphFetch(`${itemPath(root, relativePath)}/content`);
  if (!response.ok) throw new Error(`Não foi possível carregar a imagem (${response.status}).`);
  return response.blob();
}

export async function listFiles(relativeFolder) {
  assertRoot();
  const result = await graphJson(`${itemPath(root, relativeFolder)}/children?$select=id,name,eTag,file,folder&$top=999`);
  return result.value || [];
}

export async function readJsonFile(relativePath) {
  assertRoot();
  const response = await graphFetch(`${itemPath(root, relativePath)}/content`);
  if (!response.ok) throw new Error(`Não foi possível ler ${relativePath} (${response.status}).`);
  return JSON.parse(await response.text());
}

export async function writeJsonFile(relativePath, value, ifMatch) {
  assertRoot();
  return putFile(root, relativePath, new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), 'application/json', ifMatch);
}

export async function deleteFile(relativePath) {
  assertRoot();
  const response = await graphFetch(itemPath(root, relativePath), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`Não foi possível excluir ${relativePath} (${response.status}).`);
  return true;
}

export async function getFileUrl(relativePath) {
  assertRoot();
  return (await getFileMetadata(root, relativePath)).webUrl;
}

export async function getRootWebUrl() {
  assertRoot();
  return (await graphJson(`${itemPath(root)}?$select=webUrl`)).webUrl;
}

function assertRoot() {
  if (!root) throw new Error('Conecte ao OneDrive antes de acessar os arquivos.');
}

function backupStorageKey() {
  return BACKUP_KEY_PREFIX + encodeURIComponent(getStorageIdentity());
}