import { ensureFolder, getFileMetadata, graphFetch, graphJson, itemPath, putFile, resolveRootFolder } from './graph.js';

let root = null;
let dbEtag = null;
let rawSnapshot = null;

export async function connectOneDrive(folderName) {
  root = await resolveRootFolder(folderName);
  await Promise.all(['Backup', 'Fotos', 'Anexos', 'Config'].map((folder) => ensureFolder(root, folder)));
  return root;
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
    await saveDB(first, { skipBackup: true });
    return first;
  }
}

export async function saveDB(data, { skipBackup = false } = {}) {
  assertRoot();
  if (!skipBackup && rawSnapshot) await backupDB();
  const next = structuredClone(data);
  next.meta = { ...(next.meta || {}), updatedAt: new Date().toISOString(), lastBackupAt: localStorage.getItem('maria-onedrive-last-backup') || null };
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
  if (localStorage.getItem('maria-onedrive-last-backup') === day || !rawSnapshot) return false;
  await putFile(root, `Backup/dados_${day}.json`, new Blob([rawSnapshot], { type: 'application/json' }), 'application/json');
  localStorage.setItem('maria-onedrive-last-backup', day);
  return true;
}

export async function restoreDB(relativePath) {
  assertRoot();
  const response = await graphFetch(`${itemPath(root, relativePath)}/content`);
  if (!response.ok) throw new Error(`Não foi possível ler o backup (${response.status}).`);
  const restored = JSON.parse(await response.text());
  await saveDB(restored, { skipBackup: true });
  return restored;
}

export async function uploadFile(relativePath, blob, mimeType) {
  assertRoot();
  return putFile(root, relativePath, blob, mimeType);
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
