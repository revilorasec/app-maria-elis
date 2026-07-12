import { getAccessToken } from './auth.js?v=15';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

export async function graphFetch(path, options = {}, retry = true) {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_ROOT}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  if (response.status === 429 && retry) {
    const seconds = Number(response.headers.get('Retry-After') || 2);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return graphFetch(path, options, false);
  }
  return response;
}

export async function graphJson(path, options) {
  const response = await graphFetch(path, options);
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Microsoft Graph ${response.status}: ${body.slice(0, 180)}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export async function resolveRootFolder(folderName) {
  const root = await graphJson('/me/drive/root/children?$select=id,name,folder,remoteItem,parentReference&$top=999');
  const item = root.value?.find((candidate) => candidate.name === folderName && (candidate.folder || candidate.remoteItem?.folder));
  if (!item) {
    throw new Error(`A pasta "${folderName}" não foi encontrada na raiz do OneDrive. Crie essa pasta ou compartilhe-a com esta conta. Se ela foi compartilhada, abra a pasta no OneDrive e escolha "Adicionar atalho aos Meus arquivos" antes de tentar novamente.`);
  }
  const remote = item.remoteItem;
  return remote
    ? { driveId: remote.parentReference.driveId, itemId: remote.id }
    : { driveId: item.parentReference.driveId, itemId: item.id };
}

export async function ensureFolder(root, relativePath) {
  let current = root;
  for (const name of relativePath.split('/').filter(Boolean)) {
    const children = await graphJson(`/drives/${current.driveId}/items/${current.itemId}/children?$select=id,name,folder,parentReference&$top=999`);
    let child = children.value?.find((candidate) => candidate.name === name && candidate.folder);
    if (!child) {
      child = await graphJson(`/drives/${current.driveId}/items/${current.itemId}/children`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })
      });
    }
    current = { driveId: current.driveId, itemId: child.id };
  }
  return current;
}

export function itemPath(root, relativePath = '') {
  const encoded = relativePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `/drives/${root.driveId}/items/${root.itemId}${encoded ? `:/${encoded}:` : ''}`;
}

export async function putFile(root, relativePath, blob, mimeType = 'application/octet-stream', ifMatch) {
  const parent = relativePath.split('/').slice(0, -1).join('/');
  if (parent) await ensureFolder(root, parent);

  if (blob.size < 3_800_000) {
    const response = await graphFetch(`${itemPath(root, relativePath)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType, ...(ifMatch ? { 'If-Match': ifMatch } : {}) },
      body: blob
    });
    if (!response.ok) {
      const error = new Error(`Falha ao enviar arquivo (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  const session = await graphJson(`${itemPath(root, relativePath)}/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
  });
  const chunkSize = 5 * 1024 * 1024;
  let position = 0;
  let last;
  while (position < blob.size) {
    const end = Math.min(position + chunkSize, blob.size);
    last = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${position}-${end - 1}/${blob.size}` },
      body: blob.slice(position, end)
    });
    if (!last.ok && last.status !== 202) throw new Error(`Falha ao enviar arquivo (${last.status}).`);
    position = end;
  }
  return last.json();
}

export async function getFileMetadata(root, relativePath) {
  return graphJson(`${itemPath(root, relativePath)}?$select=id,name,eTag,webUrl,file`);
}
